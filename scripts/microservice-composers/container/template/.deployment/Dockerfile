FROM node:10.15.1

RUN useradd -c 'app' -m -d /home/seamless -s /bin/bash seamless
RUN chown -R seamless:seamless /usr/src

USER seamless
ENV HOME /home/seamless

# set environment variables
ENV NODE_ENV=production
ENV LOGGING_LEVEL=debug
%TEST_MODE%

ENV AWS_REGION=%AWS_REGION%

# Install app
COPY ./ /usr/src/app
COPY ./certificates/rds-combined-ca-bundle.pem /usr/src/app/
COPY ./node_modules /usr/src/app/node_modules
COPY ./package.json /usr/src/
COPY ./package.json /usr/src/app

WORKDIR /usr/src/app

EXPOSE 3030

CMD ["node", "index.js"]
