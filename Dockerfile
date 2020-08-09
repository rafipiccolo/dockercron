FROM node

WORKDIR /usr/app

RUN npm install -g forever

COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000

CMD ["npm", "start"]
