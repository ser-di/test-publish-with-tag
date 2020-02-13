const express = require('@feathersjs/express')
const rest = require('@feathersjs/express/rest')
const bodyParser = require('body-parser')
const application = require('@seamlesspay/application')
const storage = require('@seamlesspay/storage')
const { getServiceHandler } = require('@seamlesspay/utils')

const debug = require('@seamlesspay/logger')({ prefix: `$microservice_name> ` })
const port = $port

const serviceHandler = getServiceHandler({
  application,
  type: 'container',
  dependencies: require('./package.json').dependencies,
  express,
  rest,
  bodyParser,
  port,
  storage
})
const server = serviceHandler({ env: process.env.SEAMLESSPAY_ENV })

server.on('listening', () => debug(`Server running on port ${port}`))
