/* eslint-disable promise/no-promise-in-callback */
/* eslint-disable promise/always-return */
import moment from 'moment';
import fs from 'fs';
import Stream from 'stream';
import monitoring from './monitoring.js';
import execFilePromise from './execFilePromise.js';

export default function dockerExec(docker, sshconfig, id, options, callback) {
    options.runningdata ||= {};
    options.runningdata.start = new Date();

    const hrstart = process.hrtime();

    let timeouted = 0;
    let timeout = null;

    let called = false;
    function safecallback(err, data) {
        if (called) return;
        called = 1;

        const hrend = process.hrtime(hrstart);

        data ||= {};
        data.ms = hrend[0] * 1000 + hrend[1] / 1000000;
        data.timeout = timeouted;

        callback(err, data);
    }

    // create an exec on the container
    const container = docker.getContainer(id);
    const params = {
        Cmd: ['sh', '-c', options.command],
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Env: [],
    };
    options.runningdata.state = 'getcontainer';
    if (options.user) params.User = options.user;
    container.exec(params, (err, exec) => {
        if (err) options.runningdata.state = 'exec failed';
        if (err) return safecallback(err);
        options.runningdata.state = 'exec';

        // start to execute
        exec.start((err, stream) => {
            if (err) return safecallback(err);
            options.runningdata.state = 'execstart';

            // on attend X secondes, puis on kill le process si il est encore en cours
            if (options.timeout) {
                timeout = setTimeout(() => {
                    exec.inspect((err, data) => {
                        options.runningdata.state = 'inspect for timeout';
                        // if (err) return safecallback(err);
                        if (err) return monitoring.log('error', 'dockerExec', `cant inspect exec on ${id} ${err.message}`, { err });

                        timeouted = 1;
                        // kill the process
                        let command = 'sh';
                        let params = [`-c`, `kill ${data.Pid}`];
                        if (sshconfig) {
                            command = 'ssh';
                            params = [`${sshconfig}`, `kill ${data.Pid}`];
                        }
                        options.runningdata.state = 'killing';
                        execFilePromise(command, params)
                            .then(({ stdout }) => {
                                options.runningdata.state = 'killed';
                                // all good. no need to do anything because the main job will return, now that its killed
                            })
                            .catch((err) => {
                                monitoring.log('error', 'dockerExec', `cant kill process ${data.Pid} ${err.message}`, { err });
                            });
                    });
                }, options.timeout * 1000);
            }

            // get single streams from the big stream
            const stdout = new Stream.PassThrough();
            const stderr = new Stream.PassThrough();
            container.modem.demuxStream(stream, stdout, stderr);
            options.runningdata.state = 'demux';

            try {
                fs.mkdirSync(`log/${options.name}`, { recursive: true });
            } catch (err) {
                monitoring.log('error', 'dockerExec', `cant create log folder ${err.message}`, { err });
            }
            const writeStream = fs.createWriteStream(`log/${options.name}/${moment().format('YYYY-MM-DD--HH-mm-ss')}`, (err) => {
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
                clearTimeout(timeout);

                options.runningdata.state = 'end';

                writeStream.end();

                options.runningdata.end = new Date();

                exec.inspect((err, data) => {
                    if (err) return safecallback(err);

                    options.runningdata.state = 'inspect exit code';
                    safecallback(null, {
                        exitCode: data.ExitCode,
                    });
                });
            });
        });
    });
}
