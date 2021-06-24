let moment = require('moment');
let fs = require('fs');
let Stream = require('stream');
let monitoring = require('./monitoring.js');

module.exports = function dockerExec(docker, id, options, callback) {
    options.runningdata = options.runningdata || {};
    options.runningdata.start = new Date();

    let timeouted = 0;
    let timeout = null;

    let called = false;
    function safecallback(...a) {
        if (called) return;
        called = 1;
        callback(...a);
    }
    let hrstart = process.hrtime();

    // create an exec on the container
    let container = docker.getContainer(id);
    let params = {
        Cmd: ['sh', '-c', options.command],
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Env: [],
    };
    if (options.user) params.User = options.user;
    container.exec(params, (err, exec) => {
        if (err) return safecallback(err);

        // start to execute
        exec.start((err, stream) => {
            if (err) return safecallback(err);

            if (options.timeout) {
                timeout = setTimeout(() => {
                    exec.inspect((err, data) => {
                        // if (err) return safecallback(err);
                        if (err) return monitoring.log('error', 'dockerExec', `cant inspect exec on ${id} ${err.message}`, { err });

                        timeouted = 1;
                        dockerExec(docker, id, { command: `kill ${data.Pid}` }, () => {
                            if (err) return monitoring.log('error', 'dockerExec', `cant kill process ${data.Pid} ${err.message}`, { err });
                        });
                    });
                }, options.timeout * 1000);
            }

            // get single streams from the big stream
            let stdout = new Stream.PassThrough();
            let stderr = new Stream.PassThrough();
            container.modem.demuxStream(stream, stdout, stderr);

            try {
                fs.mkdirSync(`log/${options.name}`, { recursive: true });
            } catch (err) {
                monitoring.log('error', 'dockerExec', `cant create log folder ${err.message}`, { err });
            }
            let writeStream = fs.createWriteStream(`log/${options.name}/${moment().format('YYYY-MM-DD--HH-mm-ss')}`, (err) => {
                if (err) monitoring.log('error', 'dockerExec', `cant create log file ${err.message}`, { err });
            });
            options.runningdata.output = '';
            stdout.on('data', (chunk) => {
                options.runningdata.output += chunk;
                writeStream.write(chunk, (err) => {
                    if (err) monitoring.log('error', 'dockerExec', `cant write logs for stdout ${err.message}`, { err });
                });
            });

            stderr.on('data', (chunk) => {
                options.runningdata.output += chunk;
                writeStream.write(chunk, (err) => {
                    if (err) monitoring.log('error', 'dockerExec', `cant write logs for stderr ${err.message}`, { err });
                });
            });

            // when all is done we get exec results
            stream.on('end', () => {
                writeStream.end();

                let hrend = process.hrtime(hrstart);
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
