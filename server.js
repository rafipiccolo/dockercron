var CronJob = require('cron').CronJob;
var Docker = require('dockerode');
var request = require('request');
var docker = new Docker({socketPath: '/var/run/docker.sock'});
var dockerExec = require('./dockerExec.js');


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
    
    stream.on('data', function (chunk) {
        var data = JSON.parse(chunk.toString('utf8'));

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
        
        var m = label.match(/cron\.([a-z0-9]+)\.([a-z\-]+)/i);
        if (m) {
            cronname = m[1];
            option = m[2];
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
        dockerExec(id, cron.command, (err, data) => {
            if (err) {
                cron.running = 0;
                return console.error(err);
            }
            
            var time = new Date();
            
            console.log(cron.name+'@'+id.substr(0, 8)+' exitCode: '+data.exitCode+' stdout: '+data.stdout.trim()+' stderr: '+data.stderr.trim());
            
            influxdb({
                cronname: cron.name,
                containerId: id,
                command: cron.command,
                ...data
            });
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

// INFLUXDB output
function influxdb(data) {
    if (!process.env.INFLUXDB) return;

    var body = 'dockercron,cronname='+data.cronname+' ms='+data.ms+',exitCode='+data.exitCode+' '+(Date.now()*1000000);
    verbose('curl -XPOST '+process.env.INFLUXDB+' --data-binary '+"'"+body+"'");
    
    request({
        method: 'POST',
        url: process.env.INFLUXDB,
        body: body,
        forever: true,
    });
}
