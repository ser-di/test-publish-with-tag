const socketio = require('@feathersjs/socketio')
const sioJwt = require('socketio-jwt')
const getApp = require(`${__dirname}/../packages/application`)

const { SP_SERVICE, SP_APP = 'api' } = process.env

const appSettings = {
  'api': { port: '3030', env: 'live', prfix: 'api' },
  'api-sb': { port: '3031', env: 'sandbox', prfix: 'api' },
  'pan-vault': { port: '3040', env: 'live', prfix: 'pan-vault' },
  'pan-vault-sb': { port: '3041', env: 'sandbox', prfix: 'pan-vault' }
}[SP_APP]

const { SP_ENV: env = appSettings.env } = process.env

const MAX_SOCKETS_IO_LISTENERS = 300
const getService = (serviceName) => {
  if (!serviceName) return
  const service = require(`${__dirname}/../services/${serviceName}`)
  return service
}

const getAllServices = () => {
  const dependencies = require(`${__dirname}/../services/${appSettings.prfix}-services`)
  const service = {
    configure: () => () => console.log('INIT ALL SERVICES'),
    middleware: {
      after: [
        require('@seamlesspay/app-logger').middleware
      ]
    },
    dependencies
  }
  return service
}

const configureSocketServer = io => {
  io.sockets.setMaxListeners(app.get('MAX_SOCKETS_IO_LISTENERS'))
  io.set(
    'authorization',
    sioJwt.authorize({
      secret: app.get('authentication').secret,
      handshake: true
    })
  )
  io.sockets.on('error', (err) => console.error(err))
}

const service = getService(SP_SERVICE) || getAllServices()

const app = getApp({ env, service })

if (SP_APP.startsWith('api'))
  app.configure(socketio(configureSocketServer))

const server = app.listen(appSettings.port)

server.on('listening', () => console.log(`Server running on ${appSettings.port} with ${env} mode`))
