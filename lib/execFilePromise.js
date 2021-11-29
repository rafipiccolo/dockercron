import { execFile } from 'child_process';

function execFilePromise(cmd, args, options) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, options, (err, stdout, stderr) => {
            if (options && options.ignoreExitCode && err && parseInt(err.code) == err.code && err.code != 0) resolve({ stdout, stderr });

            if (err) return reject(err);

            resolve({ stdout, stderr });
        });
    });
}

export default execFilePromise;
