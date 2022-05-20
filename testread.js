import { Transform } from 'stream';

function demux() {
    const source = Buffer.from('\x01\x00\x00\x00\x03\x00\x00\x00hi!\x02\x00\x00\x00\x02\x00\x00\x00ho');

    const stdout = new Transform({
        transform(chunk, encoding, callback) {
            callback(null, chunk);
        },
    });

    const stderr = new Transform({
        transform(chunk, encoding, callback) {
            callback(null, chunk);
        },
    });

    let index = 0;
    while (index < source.length) {
        const canal = source.readUInt32LE(index);
        const nb = source.readUInt32LE(index + 4);
        const data = source.slice(index + 8, index + 8 + nb);

        if (canal == 1) stdout.write(data);
        else if (canal == 2) stderr.write(data);
        else throw new Error('bad canal found');

        index = index + 8 + nb;
    }

    return { stdout, stderr };
}

const { stdout, stderr } = demux();

stdout.on('data', (data) => {
    console.log('stdout', data.toString());
});

stderr.on('data', (data) => {
    console.log('stderr', data.toString());
});
