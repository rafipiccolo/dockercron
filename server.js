import { dirname } from 'path'
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
import cron from 'cron';
let CronJob = cron.CronJob;
import fs from 'fs';
import moment from 'moment';
import influxdb from './lib/influxdb.js';
import monitoring from './lib/monitoring.js';
import dockerapi from './lib/dockerapi.js';
import htmlentities from 'htmlentities';
import byline from 'byline';
let LineStream = byline.LineStream;

import util from 'util';
import glob from 'glob';
const globPromise = util.promisify(glob);

fs.mkdirSync('log', { recursive: true });

import cors from 'cors';
import express from 'express';
const app = express();
app.set('trust proxy', process.env.TRUST_PROXY ?? 1);
import http from 'http';
const server = http.Server(app);
monitoring.gracefulShutdown(server, app);

app.get('/favicon.ico', (req, res, next) => {
    res.sendFile(`${__dirname}/web/img/favicon.png`);
});

app.use(cors());

app.use(monitoring.idmiddleware);
app.use(monitoring.statmiddleware);
app.use(monitoring.logmiddleware);
app.use(monitoring.timermiddleware);
app.use(monitoring.multerCleanMiddleware);

app.get('/', async (req, res, next) => {
    res.sendFile(`${__dirname}/index.html`);
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

app.get('/state', async (req, res, next) => {
    let results = getCleanCrons();
    return res.send(JSON.stringify(results, null, 4));
});

app.get('/state/:id', async (req, res, next) => {
    let results = getCleanCrons();
    return res.send(JSON.stringify(results[req.params.id], null, 4));
});

app.get('/state/:id/:name', async (req, res, next) => {
    let results = getCleanCrons();
    return res.send(JSON.stringify(results[req.params.id][req.params.name], null, 4));
});

app.get('/log/:name', async (req, res, next) => {
    try {
        res.send(await globPromise(`log/${req.params.name}/*`));
    } catch (err) {
        next(err);
    }
});

app.get('/log/:name/:file', async (req, res, next) => {
    try {
        let content = await fs.promises.readFile(`log/${req.params.name}/${req.params.file}`);

        res.send(`<pre>${htmlentities.encode(content.toString())}</pre>`);
    } catch (err) {
        next(err);
    }
});

app.get('/run/:id/:name', async (req, res, next) => {
    try {
        runCron(req.params.id, crons[req.params.id][req.params.name]);
        res.send('ok');
    } catch (err) {
        next(err);
    }
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

let crons = {};

// ----------
// MODE SWARM
// ----------
if (process.env.SWARM == '1' || process.env.SWARM == 'true') {
    // list services and create each cron we find
    const services = await dockerapi.listServices({ timeout: 30000 });
    for (let service of services) {
        register(service.ID, service.Spec.Name, service.Spec.Labels);
    }

    // on service event, recreate all crons of that service
    const stream = await dockerapi.getEvents({
        onLine: async (data) => {
            if (data.Type == 'service') {
                if (data.Action == 'create' || data.Action == 'update') {
                    let servicedata = await dockerapi.getService({ timeout: 30000, id: data.Actor.ID });
                    register(data.Actor.ID, servicedata.Spec.Name, servicedata.Spec.Labels);
                } else if (data.Action == 'remove') {
                    register(data.Actor.ID);
                }
            }
        },
    });
}
// --------------
// MODE NON SWARM
// --------------
else {
    // list containers and create each cron we find
    const containers = await dockerapi.listContainers({ timeout: 30000 });
    for (let container of containers) {
        register(container.Id, container.Names[0], container.Labels);
    }

    // on container event, recreate all crons of that container
    const stream = await dockerapi.getEvents({
        onLine: async (data) => {
            if (data.Type == 'container') {
                if (data.Action == 'start') {
                    let containerdata = await dockerapi.getContainer({ timeout: 30000, id: data.id });
                    register(data.id, containerdata.Name, containerdata.Config.Labels);
                } else if (data.Action == 'die' || data.Action == 'stop') {
                    register(data.id);
                }
            }
        },
    });
}


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
            return await runCron(id, cron);
        },
        null,
        true,
        'Europe/Paris'
    );

    cron.job.start();
    cron.nextDate = cron.job.nextDates();
}

async function runCron(id, cron) {
    verbose(`${cron.name}@${id.substr(0, 8)} exec ${cron.command}`);

    // check if already running for no overlap mode
    if ((cron['no-overlap'] == 'true' || cron['no-overlap'] == '1') && cron.running) {
        return verbose(`${cron.name}@${id.substr(0, 8)} skip already running`);
    }

    cron.running = 1;

    // execute
    let containerIdtoexec = id;
    let sshconfig = '';
    try {
        if (process.env.SWARM == '1' || process.env.SWARM == 'true') {
            // get the first task of the service (docker service ps)
            const tasks = await dockerapi.listTasks({
                timeout: 30000,
                filters: {
                    service: [cron.serviceName],
                    'desired-state': ['running'],
                },
            });
            let infoforexec = null;
            if (tasks.length) {
                let task = tasks[0];
                const nodedata = await dockerapi.getNode({
                    timeout: 30000,
                    id: task.NodeID,
                });
                // console.log(`try to run on ${cron.serviceName}.${task.Slot}.${task.ID}@${nodedata.Description.Hostname}`);
                infoforexec = {
                    serviceName: cron.serviceName,
                    slot: task.Slot,
                    taskId: task.ID,
                    node: nodedata.Description.Hostname,
                };
            }
            if (!infoforexec) return verbose(`${cron.name}@${id.substr(0, 8)} no running container found`);

            containerIdtoexec = `${infoforexec.serviceName}.${infoforexec.slot}.${infoforexec.taskId}`;

            sshconfig = `root@${infoforexec.node}`;
        }
    } catch (err) {
        monitoring.log('error', 'events', `cant get tasks/nodes on ${id} from ${cron.name} : ${err.message}`, { err });
        return;
    }

    // TOCHECK créer le tunnel avec sshconfig => utilise la socket dans le exec

    cron.runningdata = cron.runningdata || {};
    cron.runningdata.runon = containerIdtoexec;
    cron.runningdata.start = new Date();
    cron.runningdata.output = '';
    cron.runningdata.timeout = false;

    let hrstart = process.hrtime();
    // log output
    try {
        fs.mkdirSync(`log/${cron.name}`, { recursive: true });
    } catch (err) {
        monitoring.log('error', 'dockerExec', `cant create log folder ${err.message}`, { err });
    }
    let writeStream = fs.createWriteStream(`log/${cron.name}/${moment().format('YYYY-MM-DD--HH-mm-ss')}`, (err) => {
        if (err) monitoring.log('error', 'dockerExec', `cant create log file ${err.message}`, { err });
    });

    // execute
    try {
        const data = await dockerapi.exec({
            host: sshconfig,
            timeout: cron.timeout,
            id: containerIdtoexec,
            onLine: function (data) {
                cron.runningdata.output += data;

                writeStream.write(data, (err) => {
                    if (err) monitoring.log('error', 'dockerExec', `cant write logs for stdout ${err.message}`, { err });
                });
            },
            options: {
                Cmd: ['sh', '-c', cron.command],
                AttachStdin: false,
                AttachStdout: true,
                AttachStderr: true,
                Tty: false,
                Env: [],
            },
        });

        cron.runningdata.exitCode = data.ExitCode;
    } catch (err) {
        if (err.code == 'TIMEOUT') {
            cron.runningdata.timeout = true;
        } else {
            monitoring.log('error', 'events', `cant dockerExec on ${id} ${err.message}`, { err });
        }
    }

    let hrend = process.hrtime(hrstart);
    cron.runningdata.ms = hrend[0] * 1000 + hrend[1] / 1000000;
    cron.runningdata.end = new Date();
    cron.running = 0;
    cron.nextDate = cron.job.nextDates();

    let smallcontainerId = containerIdtoexec.includes('.') ? containerIdtoexec : containerIdtoexec.substr(0, 8);
    console.log(
        `${cron.name}@${smallcontainerId} ms: ${cron.runningdata.ms} timeout: ${cron.runningdata.timeout ? 1 : 0} exitCode: ${cron.runningdata.exitCode
        } output: ${(cron.runningdata.output || '').trim()}`
    );

    writeStream.end(`\n\nms: ${cron.runningdata.ms} timeout: ${cron.runningdata.timeout ? 1 : 0} exitCode: ${cron.runningdata.exitCode}`);

    influxdb.insert(
        'dockercron',
        { hostname: process.env.HOSTNAME, cronname: cron.name },
        { exitCode: cron.runningdata.exitCode, timeout: cron.runningdata.timeout ? 1 : 0, ms: cron.runningdata.ms }
    );
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
