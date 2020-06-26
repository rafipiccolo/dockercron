# Docker Cron

register cron jobs in docker labels.
- jobs schedule have second precision (not minutes like old standard crontabs)
- jobs command are executed in the container itself
- can export metrics to influxdb for monitoring

exemple:

    - "cron.test.schedule=* * * * * *"
    - "cron.test.command=echo hi"
    - "cron.test.no-overlap=true"
    - "cron.test.timeout=5"


# Install

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
                - "cron.test.no-overlap=true"
                - "cron.test.timeout=5"

        dockercron:
            build: ./dockercron
            container_name: dockercron
            restart: always
            volumes:
                - /var/run/docker.sock:/var/run/docker.sock:ro
            environment:
                - "INFLUXDB=http://influxdb:8086/write?db=dockercron"
                - "VERBOSE=true"

The job called "test" will execute the command "echo hi" every second.

start it

    docker-compose up -d

# Update

    cd dockercron
    git pull
    cd ..
    docker-compose build dockercron
    docker-compose up -d dockercron

# Config

**environment** variables :

- INFLUXDB : (optional)

    The influxdb url used to push data.
    exemple of url :
        http://influxdb:8086/write?db=dockercron
    exemple of data written to influxdb :
        dockercron,cronname=test ms=246.950014,exitCode=0 1588797072250000000

- VERBOSE : (optional) (default 0)

    set 1 or true to see debug informations

- HOSTNAME : the hostname tag pushed to influxdb


**labels** format :

    - "cron.{cronname}.{option}={value}"

command

    - "cron.test.command=echo hi" :
    # to execute the cron command we use sh -c command
    # the command is executed on the docker container itself
    # so "sh" and the other binaries you want to use must exist in the container.

schedule

    - "cron.test.schedule=* * * * * *"
    # jobs schedule have second precision

no-overlap

    - "cron.test.no-overlap=true"
    # prevent a job to start again if already running

timeout

    - "cron.test.tiemout=true"
    # kill the job if timeout is reached


# How it works

On startup we call docker to get all running containers labels
and then we register the cronjobs we found

In parralel we poll docker events :
- everytime a container is "die" / "stop" => remove all cronjobs of this container
- everytime a container is "start" => remove and then register all cronjobs of this container

This package is used to parse and execute cron jobs : https://www.npmjs.com/package/cron
This package is used to communicate with docker : https://www.npmjs.com/package/dockerode
