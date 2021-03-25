let CronJob = require('cron').CronJob;
let Docker = require('dockerode');
let fs = require('fs');
let cors = require('cors');
let moment = require('moment');
let docker = new Docker({ socketPath: '/var/run/docker.sock' });
let influxdb = require('./lib/influxdb');
let dockerExec = require('./dockerExec.js');
let LineStream = require('byline').LineStream;

fs.mkdirSync('log', { recursive: true });

const express = require('express');
let monitoring = require('./lib/monitoring.js');
const app = express();
app.set('trust proxy', process.env.TRUST_PROXY ?? 1);
const http = require('http');
const server = http.Server(app);
monitoring.gracefulShutdown(server, app);

app.use(cors());

app.use(monitoring.idmiddleware);
app.use(monitoring.statmiddleware);
app.use(monitoring.logmiddleware);
app.use(monitoring.multerCleanMiddleware);

app.get('/', async (req, res, next) => {
    res.sendFile(`${__dirname}/index2.html`);
});

function getCleanCrons() {
    let results = {};

    for (let id in crons) {
        results[id] = {};
        for (let name in crons[id]) {
            results[id][name] = {};
            for (let field in crons[id][name]) {
                if (field == 'job') continue;

                results[id][name][field] = crons[id][name][field];
            }
        }
    }

    return results;
}

app.get('/state', (req, res) => {
    let results = getCleanCrons();
    return res.send(JSON.stringify(results, null, 4));
});

app.get('/state/:id', (req, res) => {
    let results = getCleanCrons();
    return res.send(JSON.stringify(results[req.params.id], null, 4));
});

app.get('/state/:id/:name', (req, res) => {
    let results = getCleanCrons();
    return res.send(JSON.stringify(results[req.params.id][req.params.name], null, 4));
});

app.get('/data', async (req, res, next) => {
    try {
        let sql = `from(bucket: "bucket")
        |> range(start: -5m)
        |> filter(fn: (r) => r["_measurement"] == "dockercron")
        ${parseInt(req.query.error) ? '|> filter(fn: (r) => r["_field"] == "exitCode" and r["_value"] != 0)' : ''}
        |> filter(fn: (r) => r["hostname"] == "${process.env.HOSTNAME}")
        |> sort(columns:["_time"], desc: true)
        |> limit(n:1000)`;

        let data = await influxdb.query(sql);
        res.send(data);
    } catch (err) {
        next(err);
    }
});

app.get('/stats', (req, res, next) => {
    return res.send(monitoring.getStatsBy(req.query.field || 'avg'));
});

app.use(monitoring.notfoundmiddleware);
app.use(monitoring.errormiddleware(app));

const port = process.env.PORT || 3000;
server.listen(port, () => {
    console.log(`ready to go on ${port}`);
});
// all crons
let crons = {};

// get all containers on startup and register all crons
docker.listContainers((err, containers) => {
    if (err) throw err;

    containers.forEach((container) => {
        register(container.Id, container.Names[0], container.Labels);
    });
});

// on container event, recreate all crons
docker.getEvents({}, (err, stream) => {
    if (err) throw err;

    let lineStream = new LineStream({ encoding: 'utf8' });
    stream.pipe(lineStream);
    lineStream.on('data', (chunk) => {
        let data = JSON.parse(chunk);

        // console.log('EVENT', data.id, data.Type, data.Action);
        // console.log('EVENTDETAIL', JSON.stringify(data));
        if (data.Type == 'container') {
            if (data.Action == 'start') {
                let container = docker.getContainer(data.id);
                container.inspect((err, containerdata) => {
                    if (err) return console.error(err);

                    register(data.id, containerdata.Name, containerdata.Config.Labels);
                });
            } else if (data.Action == 'die' || data.Action == 'stop') {
                register(data.id);
            }
        }
    });
});

// labels from docker compose
//
// labels:
// - "cron.test.schedule=* * * * * *"
// - "cron.test.command=echo raf"
//
// => get by dockerode
//
// let labels = {
//     "cron.test.schedule": "* * * * * *",
//     "cron.test.command": "echo raf",
// }
//
// => parsed
//
// { test: { name: 'test', command: 'echo raf', schedule: '* * * * * *' } }
//
function register(id, name, labels) {
    labels = labels || {};

    // remove all crons of this container
    removeAllCronsForContainer(id);

    // parse all crons of this container
    let nb = 0;
    for (let label in labels) {
        let value = labels[label];

        let m = label.match(/^cron\.([a-z0-9]+)\.([a-z\-]+)$/i);
        if (m) {
            let cronname = m[1];
            let option = m[2];
            crons[id] = crons[id] || {};
            crons[id][cronname] = crons[id][cronname] || {};
            crons[id][cronname][option] = value;
            crons[id][cronname].containerId = id;
            crons[id][cronname].containerName = name;
            crons[id][cronname].name = cronname;
            if (option == 'command') nb++;
        }
    }

    verbose(`${id.substr(0, 8)} found ${nb} cronjobs`);

    // start all detected crons
    addAllCronsForContainer(id);
}

function addAllCronsForContainer(id) {
    for (let name in crons[id]) {
        createCron(id, crons[id][name]);
    }
}

function createCron(id, cron) {
    console.log(`${cron.name}@${id.substr(0, 8)} install ${cron.schedule} ${cron.command}`);

    cron.job = new CronJob(
        cron.schedule,
        () => {
            verbose(`${cron.name}@${id.substr(0, 8)} exec ${cron.command}`);

            // check if already running for no overlap mode
            if ((cron['no-overlap'] == 'true' || cron['no-overlap'] == '1') && cron.running) {
                return verbose(`${cron.name}@${id.substr(0, 8)} skip already running`);
            }
            cron.running = 1;

            // execute
            dockerExec(id, cron, async (err, data) => {
                cron.runningdata = { ...cron.runningdata, ...data };

                cron.running = 0;
                if (err) console.error(err);

                console.log(
                    `${cron.name}@${id.substr(0, 8)} ms: ${data.ms} timeout:${data.timeout ? 1 : 0} exitCode: ${
                        data.exitCode
                    } output: ${cron.runningdata.output.trim()}`
                );

                influxdb.insert(
                    'dockercron',
                    { hostname: process.env.HOSTNAME, cronname: cron.name },
                    { exitCode: data.exitCode, timeout: data.timeout, ms: data.ms }
                );
            });
        },
        null,
        true,
        'Europe/Paris'
    );

    cron.job.start();
}

function removeAllCronsForContainer(id) {
    for (let name in crons[id]) {
        let cron = crons[id][name];
        if (cron.job) cron.job.stop();
        delete crons[id][name];
    }
}

// VERBOSE output
function verbose(s) {
    if (process.env.VERBOSE == 'true' || process.env.VERBOSE == '1') console.log(s);
}
