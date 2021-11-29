import cron from 'cron';
let CronJob = cron.CronJob;

let job = new CronJob(
    '* * * * * *',
    async () => {
        console.log(new Date(), 'ok');
        throw new Error('shit');
    },
    null,
    true,
    'Europe/Paris'
);

job.start();
