var CronJob = require('cron').CronJob;
var Docker = require('dockerode');
var fs = require('fs');
var cors = require('cors');
var moment = require('moment');
var docker = new Docker({ socketPath: '/var/run/docker.sock' });
var influxdb = require('./lib/influxdb');
var dockerExec = require('./dockerExec.js');
var LineStream = require('byline').LineStream;

fs.mkdirSync('log', { recursive: true });

const express = require('express');
var monitoring = require('./lib/monitoring.js');
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
    var results = {};

    for (var id in crons) {
        results[id] = {};
        for (var name in crons[id]) {
            results[id][name] = {};
            for (var field in crons[id][name]) {
                if (field == 'job') continue;

                results[id][name][field] = crons[id][name][field];
            }
        }
    }

    return results;
}

app.get('/state', (req, res) => {
    var results = getCleanCrons();
    return res.send(JSON.stringify(results, null, 4));
});

app.get('/state/:id', (req, res) => {
    var results = getCleanCrons();
    return res.send(JSON.stringify(results[req.params.id], null, 4));
});

app.get('/state/:id/:name', (req, res) => {
    var results = getCleanCrons();
    return res.send(JSON.stringify(results[req.params.id][req.params.name], null, 4));
});

app.get('/data', async (req, res, next) => {
    try {        
        var sql = `from(bucket: "bucket")
        |> range(start: -5m)
        |> filter(fn: (r) => r["_measurement"] == "dockercron")
        ${parseInt(req.query.error) ? '|> filter(fn: (r) => r["_field"] == "exitCode" and r["_value"] != 0)' : ''}
        |> filter(fn: (r) => r["hostname"] == "${process.env.HOSTNAME}")
        |> sort(columns:["_time"], desc: true)
        |> limit(n:1000)`;
        
        var data = await influxdb.query(sql);
        res.send(data);
    } catch (err) {
        next(err);
    }
});

app.get('/stats', function (req, res, next) {
    return res.send(monitoring.getStatsBy(req.query.field || 'avg'));
});

app.use(monitoring.notfoundmiddleware);
app.use(monitoring.errormiddleware(app));

const port = process.env.PORT || 3000;
server.listen(port, function () {
    console.log(`ready to go on ${port}`);
});
// all crons
var crons = {};

// get all containers on startup and register all crons
docker.listContainers(function (err, containers) {
    if (err) throw err;

    containers.forEach((container) => {
        register(container.Id, container.Names[0], container.Labels);
    });
});

// on container event, recreate all crons
docker.getEvents({}, function (err, stream) {
    if (err) throw err;

    var lineStream = new LineStream({ encoding: 'utf8' });
    stream.pipe(lineStream);
    lineStream.on('data', function (chunk) {
        var data = JSON.parse(chunk);

        // console.log('EVENT', data.id, data.Type, data.Action);
        // console.log('EVENTDETAIL', JSON.stringify(data));
        if (data.Type == 'container') {
            if (data.Action == 'start') {
                var container = docker.getContainer(data.id);
                container.inspect(function (err, containerdata) {
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
// var labels = {
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
    var nb = 0;
    for (var label in labels) {
        var value = labels[label];

        var m = label.match(/^cron\.([a-z0-9]+)\.([a-z\-]+)$/i);
        if (m) {
            var cronname = m[1];
            var option = m[2];
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
    for (var name in crons[id]) {
        createCron(id, crons[id][name]);
    }
}

function createCron(id, cron) {
    console.log(`${cron.name}@${id.substr(0, 8)} install ${cron.schedule} ${cron.command}`);

    cron.job = new CronJob(
        cron.schedule,
        function () {
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
    for (var name in crons[id]) {
        var cron = crons[id][name];
        if (cron.job) cron.job.stop();
        delete crons[id][name];
    }
}

// VERBOSE output
function verbose(s) {
    if (process.env.VERBOSE == 'true' || process.env.VERBOSE == '1') console.log(s);
}
