var CronJob = require('cron').CronJob;
var Docker = require('dockerode');
var express = require('express');
var request = require('request');
var docker = new Docker({socketPath: '/var/run/docker.sock'});
var influxdb = require('./influxdb');
var dockerExec = require('./dockerExec.js');
var LineStream = require('byline').LineStream;



const app = express()
const port = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Hello World!'))
app.get('/state', (req, res) => {
    return res.send(require('util').inspect(crons));
})
app.get('/state/:id', (req, res) => {
    return res.send(require('util').inspect(crons[req.params.id]));
})
app.get('/state/:id/:name', (req, res) => {
    return res.send(require('util').inspect(crons[req.params.id][req.params.name]));
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
