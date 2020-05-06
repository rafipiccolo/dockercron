FROM node

RUN apt-get update
RUN npm install -g forever

EXPOSE 3000

CMD ["npm", "start"]
