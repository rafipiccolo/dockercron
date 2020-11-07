FROM node:14

WORKDIR /usr/app

RUN npm install -g nodemon

COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000

CMD ["npm", "start"]
