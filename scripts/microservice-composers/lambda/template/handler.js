$require_services
const application = require('@seamlesspay/application')
const { hooks: accessControlHooks } = require('@seamlesspay/access-control')
const storage = require('@seamlesspay/storage')
const { getServiceHandler } = require('@seamlesspay/utils')

const useExpress = $use_express
const expressConfig = useExpress
  ? {
    express: require('@feathersjs/express'),
    rest: require('@feathersjs/express/rest'),
    bodyParser: require('body-parser'),
    port: $port
  }
  : {}

module.exports.run = getServiceHandler({
  application,
  type: 'lambda',
  // components: { services, accessControlHooks, ... } // does it make sense ?
  dependencies: require('./package.json').dependencies,
  accessControlHooks,
  ...expressConfig,
  storage$path
})
