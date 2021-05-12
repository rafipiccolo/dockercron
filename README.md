# Docker Cron

register cron jobs in docker labels.

-   jobs schedule have second precision (not minutes like old standard crontabs)
-   jobs command are executed in the container itself
-   can export metrics to influxdb for monitoring

exemple:

    - "cron.test.schedule=* * * * * *"
    - "cron.test.command=echo hi"
    - "cron.test.no-overlap=true"
    - "cron.test.timeout=5"
    - "cron.test.user=www-data"

# Install

Execute this line to download dockercron

    git clone https://github.com/rafipiccolo/dockercron.git dockercron

Create a docker-compose.yml

    version: "3.3"
    services:
        datelogger:
            image: busybox
            container_name: datelogger
            command: sh -c "while true; do id; sleep 1; done"
            restart: always
            labels:
                - "cron.test.schedule=* * * * * *"
                - "cron.test.command=sleep 2 && echo soak && sleep 2 && echo soak2 && sleep 2 && echo soak3"
                - "cron.test.timeout=5"
                - "cron.test.no-overlap=true"

        dockercron:
            build: ./dockercron
            container_name: dockercron
            restart: always
            volumes:
                - /var/run/docker.sock:/var/run/docker.sock:ro
            environment:
                - "INFLUXDB=http://influxdb:8086/write?db=dockercron"
                - "VERBOSE=true"
            labels:
                - traefik.enable=true
                - traefik.http.routers.dockercron.rule=Host(`dockercron.${DOMAIN}`)
                - traefik.http.routers.dockercron.tls.certresolver=le
                - traefik.http.routers.dockercron.entrypoints=websecure
                - traefik.http.routers.dockercron.middlewares=securityheaders,admin
            healthcheck:
                test: ['CMD', 'curl', '-f', 'http://localhost:3000/health']

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

-   INFLUXDB : (optional)

    The influxdb url used to push data.
    exemple of url :
    http://influxdb:8086/write?db=dockercron
    exemple of data written to influxdb :
    dockercron,cronname=test ms=246.950014,exitCode=0 1588797072250000000

-   VERBOSE : (optional) (default 0)

    set 1 or true to see debug informations

-   HOSTNAME : the hostname tag pushed to influxdb

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

    - "cron.test.timeout=5"
    # kill the job if timeout is reached (seconds)

user - "cron.test.user=www-data" # run the job as this user, inside the container (default root)

# available routes

-   /
-   /state
-   /state/:id
-   /state/:id/:name
-   /health

# How it works

On startup we call docker to get all running containers labels
and then we register the cronjobs we found

In parralel we poll docker events :

-   everytime a container is "die" / "stop" => remove all cronjobs of this container
-   everytime a container is "start" => remove and then register all cronjobs of this container

This package is used to parse and execute cron jobs : https://www.npmjs.com/package/cron
This package is used to communicate with docker : https://www.npmjs.com/package/dockerode
