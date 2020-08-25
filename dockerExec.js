var Docker = require('dockerode');
var Stream = require('stream');
var docker = new Docker({socketPath: '/var/run/docker.sock'});

module.exports = function dockerExec(id, options, callback) {
    options.runningdata = options.runningdata || {};
    options.runningdata.start = new Date();
    
    var called = false;
    function safecallback(...a) {
        if (called) return;
        called = 1;
        callback(...a);
    }
    var hrstart = process.hrtime()

    // create an exec on the container
    var container = docker.getContainer(id);
    var params = {
        "Cmd": ["sh", "-c", options.command],
        "AttachStdin": false,
        "AttachStdout": true,
        "AttachStderr": true,
        "Tty": false,
        "Env": []
    };
    if (options.user)
        params.User = options.user;
    container.exec(params, function(err, exec) {
        if (err) return safecallback(err);

        // start to execute
        exec.start(function (err, stream) {
            if (err) return safecallback(err);

            if (options.timeout) {
                setTimeout(() => {
                    exec.inspect((err, data) => {
                        if (err) return safecallback(err);

                        dockerExec(id, {command: 'kill ' + data.Pid}, () => {
                            if (err) return safecallback(err);

                            var err = new Error('timeout');
                            err.command = options.command;
                            safecallback(err, {
                                stdout: buffer_stdout,
                                stderr: buffer_stderr,
                            });
                        });
                    });
                }, options.timeout*1000);
            }

            // get single streams from the big stream
            var stdout = new Stream.PassThrough();
            var stderr = new Stream.PassThrough();
            container.modem.demuxStream(stream, stdout, stderr);

            var buffer_stdout = '';
            stdout.on('data', function(chunk) {
                buffer_stdout += chunk;
            });
            options.runningdata.stdout = buffer_stdout;

            var buffer_stderr = '';
            stderr.on('data', function(chunk) {
                buffer_stderr += chunk;
            });
            options.runningdata.stderr = buffer_stderr;

            // when all is done we get exec results
            stream.on('end', () => {
                var hrend = process.hrtime(hrstart)
                options.runningdata.end = new Date();

                exec.inspect((err, data) => {
                    if (err) return safecallback(err);

                    safecallback(null, {
                        ms: hrend[0]*1000 + hrend[1] / 1000000,
                        exitCode: data.ExitCode,
                        stdout: buffer_stdout,
                        stderr: buffer_stderr,
                    });
                });
            });
        });
    });
}

// module.exports('f99a4b6ddec0', 'echo rafi', console.log);
