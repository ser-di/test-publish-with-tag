#!/usr/bin/env node
const fs = require('fs-extra')
const glob = require('glob')
const path = require('path')
const load = require('load-json-file')
const documentation = require('documentation')
const yaml = require('yamljs')

const getFile = ({ fileName, filePath = '.' }) => fs.readFileSync(path.join(__dirname, filePath, fileName), 'utf8')
const postfix = getFile({ fileName: 'postfix.md' })
const paths = yaml.parse(getFile({ fileName: 'documentation.yml', filePath: '..' })).paths || []

const getEntryFilePath = packagePath => {
  const entryFilePaths = ['src/index.js', 'src/handler.js', 'index.js', 'handler.js']
  const directory = path.parse(packagePath).dir
  const indexPath = path.join(directory, entryFilePaths.find(filePath => fs.existsSync(path.join(directory, filePath))))
  return { directory, indexPath }
}

const getPackages = (pathPrefix, moduleDirName) => {
  const currentFolder = process.cwd().split(path.sep).pop()
  return currentFolder.includes(`${moduleDirName}/${pathPrefix}-`)
    ? [path.join(process.cwd(), 'package.json')]
    : glob.sync(path.join(__dirname, '..', moduleDirName, `${pathPrefix}-*`, 'package.json'))
}

const formatMarkdown = ({ markdown, name, description }) => {
  const foundObjectNames = markdown.match(/^### (.+)$/igm) || []
  const collectObjectNames = foundObjectNames.map(objectName => objectName.replace(/^### /, ''))
  const rewritedMarkdown = markdown.replace(new RegExp(`^## ${name}`, 'igm'), '')
  const commonContent = `# ${name}\n\n${description}\n\n${rewritedMarkdown}${postfix}`
  const composeMarkdown = [
    {
      name: 'moduleName',
      content: collectObjectNames.join(', ')
    },
    {
      name: 'module',
      content: name
    }
  ]
  return composeMarkdown.reduce((result, composer) => (
    result.replace(new RegExp(`{{${composer.name}}}`, 'igm'), composer.content)
  ), commonContent)
}

const packages = [
  ...getPackages('sp', 'packages'),
  ...getPackages('ps', 'functions')
]

packages.forEach(packagePath => {
  const { indexPath, directory } = getEntryFilePath(packagePath)
  const { name, description } = load.sync(packagePath)
  const buildOptions = { shallow: false }
  documentation.build(indexPath, buildOptions).then(result => {
    if (!result) console.warning(packagePath)
    console.log(' - Building Docs: ', name)
    documentation.formats.md(result, { paths })
      .then(markdown => {
        const newMarkdown = formatMarkdown({ markdown, name, description })
        fs.writeFileSync(path.join(directory, 'README.md'), newMarkdown)
      })
      .catch(error => console.warning(error))
  }).catch(error => console.warning(error))
})
