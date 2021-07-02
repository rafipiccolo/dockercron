let CronJob = require('cron').CronJob;
let fs = require('fs');
let moment = require('moment');
let influxdb = require('./lib/influxdb');
let dockerExec = require('./lib/dockerExec.js');
let monitoring = require('./lib/monitoring.js');
let Docker = require('dockerode');
let LineStream = require('byline').LineStream;

fs.mkdirSync('log', { recursive: true });

let cors = require('cors');
const express = require('express');
const app = express();
app.set('trust proxy', process.env.TRUST_PROXY ?? 1);
const http = require('http');
const server = http.Server(app);
monitoring.gracefulShutdown(server, app);

app.get('/favicon.ico', (req, res) => {
    res.sendFile(`${__dirname}/web/img/favicon.png`);
});

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

let docker = new Docker({
    // protocol: 'ssh',
    // host: `clone.gextra.net`,
    // port: 22,
    // username: 'root',
    // sshOptions: {
    //     privateKey: require('fs').readFileSync('/root/.ssh/id_rsa'),
    // },
});

// process.env.SWARM = 'true';

let crons = {};

(async () => {
    // ----------
    // MODE SWARM
    // ----------
    if (process.env.SWARM == '1' || process.env.SWARM == 'true') {
        // list services and create each cron we find
        const services = await docker.listServices();
        for (let service of services) {
            register(service.ID, service.Spec.Name, service.Spec.Labels);
        }

        // on service event, recreate all crons of that service
        const stream = await docker.getEvents({});
        let lineStream = new LineStream({ encoding: 'utf8' });
        stream.pipe(lineStream);
        lineStream.on('data', async (chunk) => {
            let data = JSON.parse(chunk);

            if (data.Type == 'service') {
                if (data.Action == 'create' || data.Action == 'update') {
                    let service = docker.getService(data.Actor.ID);
                    const servicedata = await service.inspect();
                    register(data.Actor.ID, servicedata.Spec.Name, servicedata.Spec.Labels);
                } else if (data.Action == 'remove') {
                    register(data.Actor.ID);
                }
            }
        });
    }
    // --------------
    // MODE NON SWARM
    // --------------
    else {
        // list containers and create each cron we find
        const containers = await docker.listContainers();
        for (let container of containers) {
            register(container.Id, container.Names[0], container.Labels);
        }

        // on container event, recreate all crons of that service
        const stream = await docker.getEvents({});
        let lineStream = new LineStream({ encoding: 'utf8' });
        stream.pipe(lineStream);
        lineStream.on('data', async (chunk) => {
            let data = JSON.parse(chunk);

            if (data.Type == 'container') {
                if (data.Action == 'start') {
                    let container = docker.getContainer(data.id);
                    const containerdata = await container.inspect();
                    register(data.id, containerdata.Name, containerdata.Config.Labels);
                } else if (data.Action == 'die' || data.Action == 'stop') {
                    register(data.id);
                }
            }
        });
    }
})();

//
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
// function parameters :
// id :
//   it is the serviceId or the containerId
//   it is used as a key to group crons
// name :
//   the service Name or the containerName
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
            crons[id][cronname].serviceId = id;
            crons[id][cronname].serviceName = name;
            crons[id][cronname].name = cronname;
            if (option == 'command') nb++;
        }
    }

    verbose(`${id.substr(0, 8)} found ${nb} cronjobs`);

    // create all detected crons
    for (let name in crons[id]) {
        createCron(id, crons[id][name]);
    }
}

// function parameters :
// id :
//   it is the serviceId or the containerId
function createCron(id, cron) {
    console.log(`${cron.name}@${id.substr(0, 8)} install ${cron.schedule} ${cron.command}`);

    cron.job = new CronJob(
        cron.schedule,
        async () => {
            verbose(`${cron.name}@${id.substr(0, 8)} exec ${cron.command}`);

            // check if already running for no overlap mode
            if ((cron['no-overlap'] == 'true' || cron['no-overlap'] == '1') && cron.running) {
                return verbose(`${cron.name}@${id.substr(0, 8)} skip already running`);
            }

            // execute
            let containerIdtoexec = id;
            let dockerforexec = docker;
            if (process.env.SWARM == '1' || process.env.SWARM == 'true') {
                // get the first task of the service (docker service ps)
                const tasks = await docker.listTasks({
                    filters: {
                        service: [cron.serviceName],
                        'desired-state': ['running'],
                    },
                });
                let infoforexec = null;
                if (tasks.length) {
                    let task = tasks[0];
                    const node = docker.getNode(task.NodeID);
                    const nodedata = await node.inspect();
                    console.log(`try to run on ${cron.serviceName}.${task.Slot}.${task.ID}@${nodedata.Description.Hostname}`);
                    infoforexec = {
                        serviceName: cron.serviceName,
                        slot: task.Slot,
                        taskId: task.ID,
                        node: nodedata.Description.Hostname,
                    };
                }
                if (!infoforexec) return verbose(`${cron.name}@${id.substr(0, 8)} no running container found`);

                containerIdtoexec = `${infoforexec.serviceName}.${infoforexec.slot}.${infoforexec.taskId}`;
                dockerforexec = new Docker({
                    protocol: 'ssh',
                    host: infoforexec.node,
                    port: 22,
                    username: 'root',
                    sshOptions: {
                        privateKey: require('fs').readFileSync('/root/.ssh/id_rsa'),
                    },
                });
            }

            cron.running = 1;
            dockerExec(dockerforexec, containerIdtoexec, cron, async (err, data) => {
                cron.runningdata = { ...cron.runningdata, ...data };
                cron.running = 0;
                if (err) monitoring.log('error', 'events', `cant dockerExec on ${id} ${err.message}`, { err });

                let smallcontainerId = containerIdtoexec.includes('.') ? containerIdtoexec : containerIdtoexec.substr(0, 8);
                console.log(
                    `${cron.name}@${smallcontainerId} ms: ${data.ms} timeout:${data.timeout ? 1 : 0} exitCode: ${
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
