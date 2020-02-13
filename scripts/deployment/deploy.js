const { resolve } = require('path')
const { execSync } = require('child_process')
const fs = require('fs-extra')
const Credstash = require('nodecredstash')
const { STS, Lambda, EC2, APIGateway, ApiGatewayV2, SSM, S3, CloudWatchEvents } = require('aws-sdk')
const { entries, keys } = Object
const lambdaRuntime = 'nodejs10.x'
const lambdaTimeout = 300
const lambdaMemorySize = 128
const defaultAppVersion = '1.0.0'
const defaultRegion = 'us-east-2'
const defaultEnv = 'live'
const defaultTestMode = false
const defaultServiceTimeOut = 28 // apiGateway has default timeout 29 sec 
const defaultServiceMemorySize = 1024
const defaultDeploymentConfig = {
  'type': 'lambda',
  'apiNames': ['REST']
}

const region = process.argv[2] ? process.argv[2] : defaultRegion
const env = process.argv[3] ? process.argv[3] : defaultEnv
const testMode = process.argv[4] ? process.argv[4] : defaultTestMode
const globValues = {
  region,
  env,
  testMode
}

const debug = console.log

const local = process.env.DEPLOY_LOCAL
const rootDir = resolve(`${__dirname}/../../`) // os.path.abspath('{0}/../..'.format(__dirname))
const serviceDir = process.cwd()
const deploymentPath = rootDir + '/.deployment/'

const versioHandlerFunctionName = 'version-handler-3'
const servicePackage = require(`${serviceDir}/package.json`)
const versionsConfig = require(`${rootDir}/versions.json`)

const allVersions = versionsConfig['versions']
const defaultVersion = versionsConfig['defaultVersion']
const versionsS3Bucket = 'seamlesspay-versioning'

const awsApiGatewayEndoint = local ? 'http://localhost:4567' : undefined
const awsLambdaEndoint = local ? 'http://localhost:4574' : undefined
const awsEc2Endoint = local ? 'http://localhost:4597' : undefined
const eventsEndoint = local ? 'http://localhost:4587' : undefined

const sts = new STS({ region })
const lambdaFunc = new Lambda({ region, endpoint: awsLambdaEndoint })
const ec2  = new EC2({ region, endpoint: awsEc2Endoint })
const apiGateway = new APIGateway({ region, endpoint: awsApiGatewayEndoint })
const apiGatewayV2 = new ApiGatewayV2({ region })
const ssm = new SSM({ region })
const s3 = new S3({ region })
const cloudWatchEvents = new CloudWatchEvents({ region, endpoint: eventsEndoint })

const credstashFileName = `/tmp/credstash-${region}.json`
const credstashCache = fs.existsSync(credstashFileName) ? JSON.parse(fs.readFileSync(credstashFileName)) : {}
const ssmCache = {}

const getVpcConfig = async () => {
  debug('GET VPC CONFIG ...')
  const [subnets, securityGroups] = await Promise.all([
    ec2.describeSubnets({
      Filters: [{
        'Name': 'tag:Name',
        'Values': [
          'PAYMENT-SYSTEM-PRIVATE-A',
          'PAYMENT-SYSTEM-PRIVATE-B'
        ]
      }]
    }).promise(),
    ec2.describeSecurityGroups({
      Filters:[{
        'Name': 'tag:Name',
        'Values': [
          'PAYMENT-SYSTEM-INSTANCE'
        ]
      }]
    }).promise()
  ])

  return {
    SubnetIds: subnets.Subnets.map(({ SubnetId }) => SubnetId),
    SecurityGroupIds: securityGroups.SecurityGroups.map(({ GroupId }) => GroupId)
  }
}

const putVersionsForResource = (resource, versions) => 
  s3.putObject({
    Bucket: versionsS3Bucket,
    Key: `api-gateway/${resource}.cfg`,
    ACL: 'private',
    Body: JSON.stringify(versions)
  }).promise()

const createVersionHandler = async () => {
  debug("Create version handler function ...")
  const { Account: accountID } = await sts.getCallerIdentity().promise()
  const serviceRoleArn = `arn:aws:iam::${accountID}:role/sp-service`
  const versionHandlerDeploymentPath = `${deploymentPath}/version-handler`
  fs.mkdirSync(versionHandlerDeploymentPath, { recursive: true })
  fs.copyFileSync(`${__dirname}/templates/lambda/version-handler.js.tpl`, `${versionHandlerDeploymentPath}/index.js`)
  
  execSync(`cd ${versionHandlerDeploymentPath}; zip -r  ../version-handler.zip *`)

  return lambdaFunc.createFunction({
    FunctionName: versioHandlerFunctionName,
    Runtime: lambdaRuntime,
    Role: serviceRoleArn,
    Handler: 'index.handler',
    Code: {
      'ZipFile': fs.readFileSync(`${deploymentPath}/version-handler.zip`)
    },
    Timeout: lambdaTimeout,
    MemorySize: lambdaMemorySize,
    Publish: true,
    VpcConfig: await getVpcConfig()
  }).promise()
}

const getVersionHandlerARN = async () => {
  try {
    const { FunctionArn } = await lambdaFunc.getFunctionConfiguration({ FunctionName: versioHandlerFunctionName }).promise()
    return FunctionArn
  } catch (error) {
    const { FunctionArn } = await createVersionHandler()
    return FunctionArn
  }
}

const getCredstashValue = async path => {
  const [region, table, valName] = path.split('/')
  if (!credstashCache[table]) {
    debug(`GET credstash values from ${table} ...`)
    credstashCache[table] = await new Credstash({
      table,
      awsOpts: { region }
    }).getAllSecrets()
  }
  fs.writeFileSync(credstashFileName, JSON.stringify(credstashCache))
  return credstashCache[table][valName]
}

const getSsmValue = async path => {
  const [stage, configSection, valName] = path.split('/')
  const ssmPath = `/${stage}/${configSection}/`

  if (!ssmCache[ssmPath]) {
    debug(`GET SSM values from ${ssmPath} ...`)
    ssmCache[ssmPath] = {}
    let hasNext = true
    let nextToken = undefined
    while (hasNext) {
      const res = await ssm.getParametersByPath({ Path: ssmPath, NextToken: nextToken }).promise()
      const { Parameters: ssmResponse, NextToken } = res
      ssmCache[ssmPath] = ssmResponse.reduce(
        (result, curent) => ({ ...result, [curent.Name.split('/').pop()]: curent.Value })
        , ssmCache[ssmPath]
      )
      hasNext = Boolean(NextToken)
      nextToken = NextToken
    }
  }
  return ssmCache[ssmPath][valName] || ''
}

const getValue = value => globValues[value]

const getEnvironmentVariables = async envValues => {
  debug("Get environment values ...")
  const handlerSources = {
    'credstash': getCredstashValue,
    'env': name => process.env[name],
    'ssm': getSsmValue,
    'val': getValue,
    'orig': val => val
  }
  return entries(envValues).reduce(
    async (resultPromise, [name, origValue]) => {
      const result = await resultPromise
      const [all, tpl] = (/\$\{(.*)}/).exec(origValue) || []
      if (!all) {
        return { ...result, [name]: origValue }
      }
      const [source, path] = tpl.split('://')

      const parsedPath = path.replace('$region', region)
      const handlerBySource = handlerSources[source]
      const value = await handlerBySource(parsedPath)
      return { ...await result, [name]: origValue.replace(`\${${tpl}}`, value) }
    }
    , Promise.resolve({})
  )
}

const addToWarmUp = async (functionName, functionARN) => {
  debug(`Add to warm up ${functionARN} ...`)
  const warmUpJSON = '{ "source": "seamlesspay-warm-up" }'
  ruleName = `warm-up-${functionName}`
  const { Arn } = await cloudWatchEvents.describeRule({ Name: ruleName }).promise().catch(() => ({}))
  let newArn
  if (!Arn) {
    const { Arn } = await cloudWatchEvents.putRule({
      Name: ruleName,
      ScheduleExpression: 'cron(0/5 * * * ? *)',
      State:'ENABLED'
    }).promise()
    newArn = Arn
  }

  await cloudWatchEvents.enableRule({ Name: ruleName }).promise()

  await cloudWatchEvents.putTargets({
    Rule: ruleName,
    Targets:[
      {
        Id: functionName,
        Arn: functionARN,
        Input: warmUpJSON
      }
    ]
  }).promise()

  await lambdaFunc.addPermission({
    FunctionName: functionName,
    StatementId: ruleName,
    Action: 'lambda:InvokeFunction',
    Principal: 'events.amazonaws.com',
    SourceArn: Arn || newArn
  })
}

const deployLambda = async (args) => {
  const {
    apiVersion,
    serviceDeploymentPath,
    fullSeviceName,
    serviceName,
    appVersion,
    serviceVersion,
    serviceTimeOut = defaultServiceTimeOut,
    serviceMemorySize = defaultServiceMemorySize,
    envValues,
    npmRegistry
  } = args
  debug(`Deploy lambda function ${serviceName}-${apiVersion} ...`)
  const functionName = serviceName + '-' + apiVersion
  const { dependencies, ...rest } = JSON.parse(fs.readFileSync(`${__dirname}/templates/lambda/package.json.tpl`))
  const handlerContext = fs.readFileSync(`${__dirname}/templates/lambda/handler.js.tpl`).toString().replace('$serviceName', fullSeviceName).replace('$env', env)
  const lambdaPackage = {
    dependencies: {
      ...dependencies,
      '@seamlesspay/application': appVersion,
      [fullSeviceName]: serviceVersion
    },
    ...rest
  }
  fs.mkdirSync(`${serviceDeploymentPath}/src`, { recursive: true })
  fs.writeFileSync(`${serviceDeploymentPath}/src/package.json`, JSON.stringify(lambdaPackage))
  fs.removeSync(`${serviceDeploymentPath}/src/__tests__`)
  debug('COMMAND: ', `cd ${serviceDeploymentPath}/src; npm i --no-audit --prefer-offline --production ${npmRegistry}`)
  execSync(`cd ${serviceDeploymentPath}/src; npm i --no-audit --prefer-offline --production ${npmRegistry}`)
  fs.removeSync(`${serviceDeploymentPath}/src/node_modules/aws-sdk`)
  fs.writeFileSync(`${serviceDeploymentPath}/src/index.js`, handlerContext)

  debug("Making archive ... ")
  execSync(`cd ${serviceDeploymentPath}/src; zip -r  ../lambda.zip *`)

  const { Configuration: { FunctionArn } = {} } = (await lambdaFunc.getFunction({ FunctionName: functionName }).promise().catch(console.error)) || {}

  if (!FunctionArn) {
    debug('Create function ...')
    const { Account: accountID } = await sts.getCallerIdentity().promise()
    const serviceRoleArn = `arn:aws:iam::${accountID}:role/sp-service`
    const { FunctionArn } = await lambdaFunc.createFunction({
      FunctionName: functionName,
      Runtime: lambdaRuntime,
      Role: serviceRoleArn,
      Handler: 'index.handler',
      Code: {
          'ZipFile': fs.readFileSync(`${serviceDeploymentPath}/lambda.zip`)
      },
      Timeout: serviceTimeOut,
      MemorySize: serviceMemorySize,
      Publish: true,
      VpcConfig: await getVpcConfig(),
      TracingConfig: {
        'Mode': 'Active'
      },
      Environment: {
        'Variables': await getEnvironmentVariables(envValues)
      }
    }).promise()
    fs.removeSync(serviceDeploymentPath)
    return FunctionArn
  }

  debug('Update function code ...')
  await lambdaFunc.updateFunctionCode({
    FunctionName: functionName,
    ZipFile: fs.readFileSync(`${serviceDeploymentPath}/lambda.zip`)
  }).promise()
  await lambdaFunc.updateFunctionConfiguration({
    FunctionName: functionName,
    Runtime: lambdaRuntime,
    Timeout: serviceTimeOut,
    MemorySize: serviceMemorySize,
    VpcConfig: await getVpcConfig(),
    Environment: {
      'Variables': await getEnvironmentVariables(envValues)
    }
  }).promise()
  fs.removeSync(serviceDeploymentPath)
  await addToWarmUp(functionName, FunctionArn)
  return FunctionArn
}

const getRestApiID = async apiName => {
  debug("Get REST API ID ...")
  const response = await apiGateway.getRestApis().promise().catch(console.error)
  const { items: restApiList = [] } = response
  const { id = null } = restApiList.find(({ name }) => name === apiName) || {}
  return id
}

const getWebsocketApiID = async apiName => {
  if (local) return ''
  debug("Get Websocket API ID ...")
  const { items: apiList = [] } = await apiGatewayV2.getApis().promise().catch(() => ({}))
  const { id = null } = apiList.find(({ Name }) => Name === apiName) || {}

  return id
}

const getResources = async (restApiId) => {
  const { items: resources = [] } = await apiGateway.getResources({
    restApiId,
    limit: 500
  })
  .promise()
  .catch((error) => {debug('ERROR: ', error)})
  .then(data => data || {})

  return resources
}

const getResourceID = async (restApiId, path) => {
  debug(`Get Resource ID for ${path} ...`)
  const resourcePath = path.replace(/^\//,'')
  const resources = await getResources(restApiId)
  const { id: resourceID } = resources.find(({ path }) => path === `/${resourcePath}`) || {}  
  debug('[getResourceID] resourceID: ', resourceID)
  if (resourceID) return resourceID

  debug(`Create Resource for ${path} ...`)
  const root = resources.find(({ path }) => path === '/')
  const pathParts = resourcePath.split('/')
  let curentResourceID = root.id
  let curentPath = '/'
  for (part in pathParts) {
    debug('[getResourceID] curentResourceID: ', curentResourceID)
    debug('[getResourceID] pathParts: ', pathParts)
    debug('[getResourceID] part: ', pathParts[part])
    const { id, path } = resources.find(({ parentId, pathPart }) => pathPart === pathParts[part] && parentId === curentResourceID) || {}
    debug(`[getResourceID] path: ${path}; id: ${id} `)
    if (id) {
      curentResourceID = id
      curentPath = path
    } else {
      const { id, path } = await apiGateway.createResource({
        restApiId,
        parentId: curentResourceID,
        pathPart: pathParts[part]
      })
      .promise()
      curentResourceID = id
      curentPath = path
    }
  }
  if (curentPath.replace(/^\//,'') !== resourcePath.replace(/^\//,''))
    throw new Error(`\nERROR: Resource path " + ${curentPath} is not equal ${resourcePath}\n`)
  
  return curentResourceID
}

const putCors = async ({ apiID, resourceID }) => {
  debug("Put CORS integration")

  const responseParameters = {
    'method.response.header.Access-Control-Allow-Headers': true,
    'method.response.header.Access-Control-Allow-Methods': true,
    'method.response.header.Access-Control-Allow-Origin': true,
    'method.response.header.Access-Control-Allow-Credentials': true
  }

  const integrationParameters = {
    'method.response.header.Access-Control-Allow-Headers': `'authorization,client-type,content-type,method,api-version,sdk-version,accepted-version,version'`,
    'method.response.header.Access-Control-Allow-Methods': `'OPTIONS,POST,GET,PUT,DELETE'`,
    'method.response.header.Access-Control-Allow-Origin': `'*'`,
    'method.response.header.Access-Control-Allow-Credentials': `'false'`
  }

  await apiGateway.deleteMethod({
    restApiId: apiID,
    resourceId: resourceID,
    httpMethod: 'OPTIONS'
  })
  .promise()
  .catch(() => {})
  debug('apiGateway.deleteMethod: ', resourceID)
  await apiGateway.putMethod({
    restApiId: apiID,
    resourceId: resourceID,
    httpMethod: 'OPTIONS',
    authorizationType: 'NONE',
    requestModels: {
      'application/json': 'Empty'
    }
  }).promise().catch(() => {})
  debug('apiGateway.putMethod: ', resourceID)
  await apiGateway.putIntegration({
    restApiId: apiID,
    resourceId: resourceID,
    httpMethod: 'OPTIONS',
    type: 'MOCK',
    requestTemplates: {
      'application/json': '{"statusCode": 200}'
    },
    passthroughBehavior: 'WHEN_NO_TEMPLATES',
    cacheKeyParameters: []
  }).promise().catch((error) => {  console.log('ERROR: ', error) })
  

  debug('apiGateway.putIntegration: ', resourceID)
  await apiGateway.putMethodResponse({
    restApiId: apiID,
    resourceId: resourceID,
    httpMethod: 'OPTIONS',
    statusCode: '200',
    responseModels: {
      "application/json": "Empty"
    },
    responseParameters
  }).promise().catch((error) => {  console.log('ERROR: ', error) })

  debug('apiGateway.putMethodResponse: ', resourceID)
  const respJson = fs.readFileSync(`${__dirname}/templates/api-gateway/response.tpl`)
  await apiGateway.putIntegrationResponse({
    restApiId: apiID,
    resourceId: resourceID,
    httpMethod: 'OPTIONS',
    statusCode: '200',
    responseTemplates: {
      "application/json": "" //respJson.toString()
    },
    responseParameters: integrationParameters
  }).promise().catch((error) => {  console.log('ERROR: ', error) })
  debug('apiGateway.putIntegrationResponse: ', resourceID)
}

const putMethod = async ({ method, apiID, resourceID, versionHandlerARN }) => {
  debug(`Put Method ${method} for ${resourceID}`)
  const { Account: accountID } = await sts.getCallerIdentity().promise()
  const apiToLambdaFunctionRole = `arn:aws:iam::${accountID}:role/apiToLambdaFunctionRole`

  await apiGateway.deleteMethod({
    restApiId: apiID,
    resourceId: resourceID,
    httpMethod: method
  }).promise().catch(() => {})

  debug('versionHandler ARN: ', versionHandlerARN)
  await apiGateway.putMethod({
    restApiId: apiID,
    resourceId: resourceID,
    httpMethod: method,
    authorizationType: 'NONE',
    requestModels: {
      'application/json': 'Empty'
    }
  }).promise().catch(() => {})

  await apiGateway.putIntegration({
    restApiId: apiID,
    resourceId: resourceID,
    httpMethod: method,
    type: 'AWS_PROXY',
    integrationHttpMethod: 'POST',
    uri: `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${versionHandlerARN}/invocations`,
    credentials: apiToLambdaFunctionRole,
    passthroughBehavior: 'WHEN_NO_TEMPLATES',
    cacheKeyParameters: [],
    timeoutInMillis: 29000
  }).promise().catch(() => {})
}

const putMethods = async (params) => {
  const { methods, resourceID, versions } = params

  await Promise.all([
    putVersionsForResource(resourceID, versions),
    ...methods.map(method => putMethod({ ...params, method }))
  ])
}

const updateApiGatewayResource = async ({ apiName, paths, versions, versionHandlerARN, cors = true }) => {
  const restApiID = await getRestApiID(apiName)
  const websocketApiID = await getWebsocketApiID(apiName)
  if (!(restApiID || websocketApiID))
    throw new Error(`\nERROR: API ${apiName} doesn't exist in region ${region}\n`)

  const apiID = restApiID || websocketApiID
  const apiType = restApiID ? 'REST' : 'WEBSOCKET'

  if (apiType == 'REST') {
    const ents = entries(paths)
    for( i in  ents) {
      const [path, methods] = ents[i]
      const resourceID = await getResourceID(apiID, path)
      debug('corsResourceId: ', resourceID)
      if (cors) {
        await putCors({ apiID, resourceID })
      }
      await putMethods({ apiID, resourceID, methods, versions, versionHandlerARN, cors })
    }
  }
  if (apiType == 'WEBSOCKET') {

  }
}

const updateApiGatewayResources = async ({ apiNames, paths, versions, versionHandlerARN, cors = true }) => {
  debug('Update Api Gateway Resources ...')

  await Promise.all(
    apiNames.map(apiName => updateApiGatewayResource({ apiName, paths, versions, versionHandlerARN, cors }))
  )
  return apiNames
}

const deployEcs = async params => {
  throw new Error('Ecs deployment is not implemented yet!!!')
}

const deployService = async servicePackage => {
  const { name: fullSeviceName, service: serviceConfig } = servicePackage
  debug(`Deploy module ${fullSeviceName} ...`)
  if (!serviceConfig) {
    throw new Error('ERROR: Service doesn\'t configured')
  }

  const npmRegistry = process.env.NPM_LOCAL ? ' --registry http://localhost:4873' : ''
  const {
    versions,
    paths,
    apiNames = defaultDeploymentConfig.apiNames,
    envValues: serviceEnvValues = {}
  }= serviceConfig
  const serviceVersions = {}
  const versionHandlerARN = await getVersionHandlerARN()

  debug('versions: ', versions) 
  await Promise.all(
    entries(versions).map(async ([apiVersion, versionConfig]) => {
      if(!allVersions[apiVersion]) {
        throw new Error(`ERROR: Version ${apiVersion} doesn't exists in ${rootDir} /versions.json`)
      }
      const {
        serviceVersion,
        appVersion = defaultAppVersion,
        timeOut:serviceTimeOut = defaultServiceTimeOut,
        memorySize: serviceMemorySize = defaultServiceMemorySize,
        envValues: versionEnvValues,
        deployment: deployConfig = defaultDeploymentConfig,
        type: deploymentType = defaultDeploymentConfig.type
      } = versionConfig
      const serviceName = fullSeviceName.replace('@seamlesspay/','')
      const envValues = { ...versionEnvValues, ...serviceEnvValues }
      const serviceDeploymentPath = `${deploymentPath}${serviceName}-${apiVersion}`
      const deployTypes = {
        'lambda': deployLambda,
        'container': deployEcs
      }
      const deploy = deployTypes[deploymentType]
      if (!deploy){
        throw new Error(`ERROR: Deployment type ${deploymentType} unsupported`)
      }

      const serviceHandler = await deploy({
        apiVersion,
        serviceDeploymentPath,
        fullSeviceName,
        serviceName,
        appVersion,
        serviceVersion,
        serviceTimeOut,
        serviceMemorySize,
        envValues,
        npmRegistry
      })

      serviceVersions[apiVersion] = {
        'type': deploymentType,
        'handler': serviceHandler
      }
    })
  )

  const sortedVersionsKeys = keys(allVersions).sort((d1, d2) => (new Date(d1)) > (new Date(d2)))
  debug('sortedVersionsKeys: ', sortedVersionsKeys)
  const { currentVersion, apiGatewayVersions } = sortedVersionsKeys.reduce(
    ({ currentVersion, apiGatewayVersions }, versionkey) => ({
      apiGatewayVersions: {
        ...apiGatewayVersions,
        [versionkey]: serviceVersions[versionkey] || currentVersion 
      },
      currentVersion: serviceVersions[versionkey] || currentVersion 
    }),
    { currentVersion: { type: 'unavailable' }, apiGatewayVersions: {} }
  )

  apiGatewayVersions['default'] = apiGatewayVersions[defaultVersion] || currentVersion
  
  await updateApiGatewayResources({
    apiNames,
    paths,
    versions: apiGatewayVersions,
    versionHandlerARN
  })

  debug(`Service ${fullSeviceName} was successfully deployed!`)
}

deployService(servicePackage).catch(console.error)