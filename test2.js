import cron from 'cron';
const CronJob = cron.CronJob;

const job = new CronJob(
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
