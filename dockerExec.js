var Docker = require('dockerode');
var moment = require('moment');
var fs = require('fs');
var Stream = require('stream');
var docker = new Docker({ socketPath: '/var/run/docker.sock' });

module.exports = function dockerExec(id, options, callback) {
    options.runningdata = options.runningdata || {};
    options.runningdata.start = new Date();

    var timeouted = 0;
    var timeout = null;

    var called = false;
    function safecallback(...a) {
        if (called) return;
        called = 1;
        callback(...a);
    }
    var hrstart = process.hrtime();

    // create an exec on the container
    var container = docker.getContainer(id);
    var params = {
        Cmd: ['sh', '-c', options.command],
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Env: [],
    };
    if (options.user) params.User = options.user;
    container.exec(params, function (err, exec) {
        if (err) return safecallback(err);

        // start to execute
        exec.start(function (err, stream) {
            if (err) return safecallback(err);

            if (options.timeout) {
                timeout = setTimeout(() => {
                    exec.inspect((err, data) => {
                        // if (err) return safecallback(err);
                        if (err) return console.error('cant inspect exec on ' + id);

                        timeouted = 1;
                        dockerExec(id, { command: 'kill ' + data.Pid }, () => {
                            if (err) return console.error('cant kill process ' + data.Pid);
                        });
                    });
                }, options.timeout * 1000);
            }

            // get single streams from the big stream
            var stdout = new Stream.PassThrough();
            var stderr = new Stream.PassThrough();
            container.modem.demuxStream(stream, stdout, stderr);

            try {
                fs.mkdirSync('log/' + options.name, {recursive: true});
            } catch(err) {
                console.error('cant create log folder', err);
            }
            var writeStream = fs.createWriteStream('log/' + options.name + '/' + moment().format('YYYY-MM-DD--HH-mm-ss'), function (err) {
                if (err) console.error('cant create log file', err);
            });
            options.runningdata.output = '';
            stdout.on('data', function (chunk) {
                options.runningdata.output += chunk;
                writeStream.write(chunk, function (err) {
                    if (err) console.error('cant write logs for stdout', err);
                });
            });

            stderr.on('data', function (chunk) {
                options.runningdata.output += chunk;
                writeStream.write(chunk, function (err) {
                    if (err) console.error('cant write logs for stderr', err);
                });
            });

            // when all is done we get exec results
            stream.on('end', () => {
                writeStream.end();

                var hrend = process.hrtime(hrstart);
                options.runningdata.end = new Date();

                clearTimeout(timeout);

                exec.inspect((err, data) => {
                    if (err) return safecallback(err);

                    safecallback(null, {
                        exitCode: data.ExitCode,
                        ms: hrend[0] * 1000 + hrend[1] / 1000000,
                        timeout: timeouted,
                    });
                });
            });
        });
    });
};

// module.exports('f99a4b6ddec0', 'echo rafi', console.log);
