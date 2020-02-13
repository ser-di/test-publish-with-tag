const os = require('os')
const fs = require('fs')
const client = new (require('npm-registry-client'))({})
const npmLogin = require('npm-cli-login')
const username = 'seamlesspay'
const password = '12345'
const email = 'info@seamlesspay.com'
const registry = 'http://localhost:4873'
try {
  npmLogin(username, password, email, registry)
} catch (err) {
  consple.error(err)
  client.adduser(
    registry,
    {
      auth: {
        username,
        password,
        email
      }
    },
    (err, data) =>
      (err && console.error(err)) ||
      fs.writeFileSync(`${os.homedir()}/.npmrc`, `\n//localhost:4873/:_authToken="${data.token}"`)
  )
}