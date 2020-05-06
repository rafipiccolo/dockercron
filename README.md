# Docker Cron

register cron jobs in docker labels.

ps: jobs specification have second precision (not minutes like old standard crontabs)

# How to use

Execute this line to download dockercron

    git clone https://github.com/rafipiccolo/dockercron.git dockercron

Create a docker-compose.yml

    version: "3.3"
    services:
        datelogger:
            image: busybox
            container_name: datelogger
            command: sh -c "while true; do $$(echo date); sleep 1; done"
            restart: always
            labels:
                - "cron.test.schedule=* * * * * *"
                - "cron.test.command=echo hi"

        dockercron:
            build: ./dockercron
            container_name: dockercron
            restart: always

The job called "test" will execute the command "echo hi" every second.

start it

    docker-compose up -d

# How it works

On startup we call docker to get all running containers labels
and then we register the cronjobs we found

In parralel we poll docker events :
- everytime a container is "die" / "stop" => remove all cronjobs of this container
- everytime a container is "start" => remove and then register all cronjobs of this container

to execute the cron command we use sh -c command
the command is executed on the docker container itself so "sh", and the other binaries you want to use, must exist in the container.

This package is used to parse and execute cron jobs : https://www.npmjs.com/package/cron
This package is used to communicate with docker : https://www.npmjs.com/package/dockerode
