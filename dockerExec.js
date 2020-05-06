var Docker = require('dockerode');
var Stream = require('stream');
var docker = new Docker({socketPath: '/var/run/docker.sock'});

module.exports = function dockerExec(id, command, callback) {
    var hrstart = process.hrtime()

    // create an exec on the container
    var container = docker.getContainer(id);
    container.exec({
        "Cmd": ["sh", "-c", command],
        "AttachStdin": false,
        "AttachStdout": true,
        "AttachStderr": true,
        "Tty": false,
        "Env": []
    }, function(err, exec) {
        if (err) return callback(err);

        // start to execute
        exec.start(function (err, stream) {
            if (err) return callback(err);

            // get single streams from the big stream
            var stdout = new Stream.PassThrough();
            var stderr = new Stream.PassThrough();
            container.modem.demuxStream(stream, stdout, stderr);

            var buffer_stdout = '';
            stdout.on('data', function(chunk) {
                buffer_stdout += chunk;
            });
            
            var buffer_stderr = '';
            stderr.on('data', function(chunk) {
                buffer_stderr += chunk;
            });

            // when all is done we get exec results
            stream.on('end', () => {
                var hrend = process.hrtime(hrstart)

                exec.inspect((err, data) => {
                    if (err) return callback(err);

                    callback(null, {
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
