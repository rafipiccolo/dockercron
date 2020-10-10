var CronJob = require('cron').CronJob;
var Docker = require('dockerode');
var express = require('express');
var moment = require('moment');
var docker = new Docker({socketPath: '/var/run/docker.sock'});
var influxdb = require('./influxdb');
var dockerExec = require('./dockerExec.js');
var LineStream = require('byline').LineStream;
const sendMail = require('./lib/sendMail');


const app = express()
const port = process.env.PORT || 3000;

JSON.safeStringify = (obj, indent = 2) => {
    let cache = [];
    const retVal = JSON.stringify(
        obj,
        (key, value) =>
            typeof value === "object" && value !== null
                ? cache.includes(value)
                    ? undefined // Duplicate reference found, discard key
                    : cache.push(value) && value // Store value in our collection
                : value,
        indent
    );
    cache = null;
    return retVal;
};

app.use((req, res, next) => {
    console.log(req.method + ' ' + req.originalUrl);
    next();
});

app.get('/', async (req, res, next) => {
    res.sendFile(__dirname + '/index.html')
});

app.get('/state', (req, res) => {
    return res.send(JSON.safeStringify(crons));
})

app.get('/state/:id', (req, res) => {
    return res.send(require('util').inspect(crons[req.params.id]));
})

app.get('/state/:id/:name', (req, res) => {
    return res.send(require('util').inspect(crons[req.params.id][req.params.name]));
})

app.get('/cron/alert', async (req, res, next) => {
    try {
        var data = await influxdb.query(`select * from dockercron where exitCode != 0 order by time desc limit 10`);

        res.send(data);
    } catch (err) {
        next(err);
    }
})

app.get('/data', async (req, res, next) => {
    try {
        var sql = '';

        var wheres = [];
        if (parseInt(req.query.error))
            wheres.push(`"exitCode" != 0`);
        wheres.push(`"host" = '${process.env.HOSTNAME}'`)
        sql = `select * from dockercron where ${wheres.join(' and ')} order by time desc limit 1000`;
        var data = await influxdb.query(sql);
        res.send(data);
    } catch (err) {
        next(err);
    }
})

app.get('/cron/alert', async (req, res, next) => {
    try {
        var errors = await influxdb.query(`select * from dockercron where "host" = '${process.env.HOSTNAME}' and exitCode != 0 and time > now() - 1d order by time desc limit 1000`);

        var html = '';
        if (errors.length) {
            html += 'Errors :\n'
            html += errors.map(error => `${moment(error.time).format('YYYY-MM-DD HH:mm:ss')} ${error.driver} ${error.host}\n`).join('');
        }

        if (html.trim() == '') return res.send('nothing to send');

        await sendMail({
            to: "rafi.piccolo@gmail.com, martin.wb.2015@gmail.com",
            subject: "dockercron " + process.env.HOSTNAME,
            text: html,
            html: html.replace(/\n/g, '<br />'),
        });

        res.send('ok');
    } catch (err) {
        next(err);
    }
})

app.get('/health', (req, res) => res.send('ok'))

app.listen(port, () => console.log(`Example app listening at http://localhost:${port}`))



// all crons
var crons = {};


// get all containers on startup and register all crons
docker.listContainers(function(err, containers) {
    if(err) throw err;

    containers.map((container) => {
        register(container.Id, container.Labels);
    })
});


// on container event, recreate all crons
docker.getEvents({}, function (err, stream) {
    if(err) throw err;
    
    var lineStream = new LineStream({encoding: 'utf8'});
    stream.pipe(lineStream);
    lineStream.on('data', function (chunk) {
        var data = JSON.parse(chunk);

        // console.log('EVENT', data.id, data.Type, data.Action);
        // console.log('EVENTDETAIL', JSON.stringify(data));
        if (data.Type == 'container') {
            if (data.Action == 'start') {
                var container = docker.getContainer(data.id);
                container.inspect(function (err, containerdata) {
                    if(err) return console.error(err);
                    
                    register(data.id, containerdata.Config.Labels);
                });
            }
            else if (data.Action == 'die' || data.Action == 'stop') {
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
function register(id, labels) {
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
            crons[id][cronname].name = cronname;
            if (option == 'command') nb++;
        }
    }

    verbose(id.substr(0, 8)+' found '+nb+' cronjobs');

    // start all detected crons
    addAllCronsForContainer(id);
}

function addAllCronsForContainer(id) {
    for (var name in crons[id]) {
        createCron(id, crons[id][name]);
    }
}

function createCron(id, cron){
    console.log(cron.name+'@'+id.substr(0, 8)+' install '+cron.schedule+' '+cron.command);

    cron.job = new CronJob(cron.schedule, function() {
        verbose(cron.name+'@'+id.substr(0, 8)+' exec '+cron.command);

        // check if already running for no overlap mode
        if ((cron['no-overlap'] == 'true' || cron['no-overlap'] == '1') && cron.running) {
            return verbose(cron.name+'@'+id.substr(0, 8)+' skip already running');
        }
        cron.running = 1;
        
        // execute
        dockerExec(id, cron, async (err, data) => {
            cron.runningdata = {...cron.runningdata, ...data};

            if (err) {
                cron.running = 0;
                console.error(err);
            }

            console.log(cron.name+'@'+id.substr(0, 8)+' ms: '+data.ms+' timeout:'+(data.timeout?1:0)+' exitCode: '+data.exitCode+' stdout: '+data.stdout.trim()+' stderr: '+data.stderr.trim());

            influxdb.insert('dockercron', { host: process.env.HOSTNAME, cronname: cron.name}, {exitCode: data.exitCode, timeout: data.timeout, ms: data.ms });
            cron.running = 0;
        });
    }, null, true, 'Europe/Paris');

    cron.job.start();
}

function removeAllCronsForContainer(id) {
    for (var name in crons[id]) {
        var cron = crons[id][name];
        if (cron.job)
            cron.job.stop();
        delete crons[id][name];
    }
}




// VERBOSE output
function verbose(s) {
    if (process.env.VERBOSE == 'true' || process.env.VERBOSE == '1')
        console.log(s);
}
