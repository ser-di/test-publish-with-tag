const watch = require('node-watch')
const rootDir = `${__dirname}/..`

const watchDir = (dir) =>
  watch(
    dir,
    {
      recursive: true
    },
    (evt, name) => {
      console.log('%s changed.', name)
      const match = name.match(new RegExp(`(${dir}/.*)/`))
      const moduleDir = match[0]
      console.log('moduleDir: ', moduleDir)
      // publishModule(moduleDir)
    })
watchDir(`${rootDir}/packages`)
