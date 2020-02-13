import sys
import os
import boto3
import json
import socket
import datetime
import credstash
import re
from shutil import make_archive
from string import Template
from time import sleep

defaultAppVersion = '1.0.0'
defaultRegion = 'us-east-2'
defaultEnv = 'live'
defaultTestMode = None
defaultServiceTimeOut = 28 # apiGateway has default timeout 29 sec
defaultServiceMemorySize = 1024
defaultDeploymentConfig = {
  'type': 'lambda',
  'apiNames': ['REST']
}

try:
  region = sys.argv[1]
except:
  region = defaultRegion

try:
  env = sys.argv[2]
except:
  env = defaultEnv

try:
  testMode = sys.argv[3]
except:
  testMode = defaultTestMode


def getEnvValue(path):
  val = os.environ.get(path, None)
  return val

local = getEnvValue('DEPLOY_LOCAL')
__dirName = os.path.dirname(os.path.abspath(__file__))
rootDir = os.path.abspath('{0}/../..'.format(__dirName))
serviceDir = os.getcwd()
deploymentPath = rootDir + '/.deployment/'

versioHandlerFunctionName = 'version-handler-3'
servicePackage = json.loads(open(serviceDir + '/package.json', 'r').read())
versionsConfig = json.loads(open(rootDir + '/versions.json', 'r').read())
allVersions = versionsConfig['versions']
defaultVersion = versionsConfig['defaultVersion']
versionsS3Bucket = 'seamlesspay-versioning'
accountID = boto3.client('sts').get_caller_identity()['Account']

awsApiGatewayEndoint = local and 'http://localhost:4567' or None
awsLambdaEndoint = local and 'http://localhost:4574' or None
awsEc2Endoint = local and 'http://localhost:4597' or None
eventsEndoint = local and 'http://localhost:4587' or None

lambdaFunc = boto3.client('lambda', region_name = region, endpoint_url = awsLambdaEndoint)
ec2 = boto3.client('ec2', region_name = region, endpoint_url = awsEc2Endoint)
apiGateway = boto3.client('apigateway', region_name = region, endpoint_url = awsApiGatewayEndoint)
apiGatewayV2 = boto3.client('apigatewayv2', region_name = region, endpoint_url = awsApiGatewayEndoint)
ssm = boto3.client('ssm', region_name = region)
dynamoDb  = boto3.client('dynamodb', region_name = region)
s3  = boto3.client('s3', region_name = region)

serviceRoleArn = 'arn:aws:iam::' + accountID + ':role/sp-service'
apiToLambdaFunctionRole = 'arn:aws:iam::' + accountID + ':role/apiToLambdaFunctionRole'
credstashCache = {}
ssmCache = {}

def isOpen(ip,port):
   s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
   try:
      s.connect((ip, int(port)))
      s.shutdown(2)
      return True
   except:
      return False

def getVpcConfig():
  subnets = ec2.describe_subnets(Filters=[{
    'Name': 'tag:Name',
    'Values': [
        'PAYMENT-SYSTEM-PRIVATE-A',
        'PAYMENT-SYSTEM-PRIVATE-B'
    ]
  }])
  securityGroups = ec2.describe_security_groups(Filters=[{
    'Name': 'tag:Name',
    'Values': [
        'PAYMENT-SYSTEM-INSTANCE'
    ]
  }])
  subnetIds = list(map(lambda sn: sn['SubnetId'], subnets['Subnets']))
  securityGroupIds = list(map(lambda sn: sn['GroupId'], securityGroups['SecurityGroups']))

  return {
    'SubnetIds': subnetIds,
    'SecurityGroupIds': securityGroupIds
  }
def putVersionsForResource(resource, versions):
  print('Put versions for resource: ' + resource)
  s3.put_object(
    Bucket = versionsS3Bucket,
    Key = 'api-gateway/' + resource + '.cfg',
    ACL='private',
    Body=bytes(json.dumps(versions))
  )

  # try:
  #   dynamoDb.create_table(
  #     TableName='Versions',
  #     AttributeDefinitions = [
  #       {
  #           'AttributeName': 'resourceID',
  #           'AttributeType': 'S'
  #       }
  #     ],
  #     KeySchema=[
  #       {
  #           'AttributeName': 'resourceID',
  #           'KeyType': 'HASH'
  #       }
  #     ],
  #     ProvisionedThroughput = {
  #       'ReadCapacityUnits': 5,
  #       'WriteCapacityUnits': 5
  #     }
  #   )
  # except:
  #   pass

  # versionsTable = boto3.resource('dynamodb').Table('Versions')
  # versionsTable.put_item(
  #   Item = {
  #     'resourceID': resource,
  #     'versions': json.dumps(versions)
  #   }
  # )


def createVersionHandler():
  print("Create version handler function ...")
  versionHandlerDeploymentPath = deploymentPath + '/version-handler'
  os.system('mkdir -p ' + versionHandlerDeploymentPath)
  handlerContext = open(__dirName + '/templates/lambda/version-handler.js.tpl', 'r').read()
  open(versionHandlerDeploymentPath + '/index.js', 'w').write(handlerContext)
  
  make_archive(deploymentPath + '/version-handler', 'zip', root_dir=versionHandlerDeploymentPath)

  response = lambdaFunc.create_function(
    FunctionName=versioHandlerFunctionName,
    Runtime='nodejs10.x',
    Role=serviceRoleArn,
    Handler='index.handler',
    Code={
      'ZipFile': open(deploymentPath + '/version-handler.zip', 'rb').read()
    },
    Description='string',
    Timeout=300,
    MemorySize=128,
    Publish=True,
    VpcConfig = getVpcConfig()
  )
  return response

def getVersionHandlerARN():
  try:
    versionHandlerConf = lambdaFunc.get_function_configuration(FunctionName = versioHandlerFunctionName)
  except:
    print('try to create versionHandler')
    versionHandlerConf = createVersionHandler()
  return versionHandlerConf['FunctionArn']

def getCredstashValue(path):
  parts = path.split('/')
  region = parts[0]
  table = parts[1]
  valName = parts[2]
  if (not credstashCache.get(table, False)):
    print("GET credstash values from " + table + " ...")
    credstashCache[table] = credstash.getAllSecrets(region = region, table = table)

  val = credstashCache[table].get(valName, None)
  return val

def getSsmValue(path):
  parts = path.split('/')
  stage = parts[0]
  configSection = parts[1]
  valName = parts[2]
  ssmPath = "/" + stage + "/" + configSection + "/"

  if (not ssmCache.get(ssmPath, False)):
    print("GET SSM values from " + ssmPath + " ...")
    values = {}
    nextToken = True
    response = ssm.get_parameters_by_path(Path = ssmPath)
    while nextToken:
      for val in response['Parameters']:
        values[val['Name'].replace(ssmPath, '')] = val['Value']

      nextToken = response.get('NextToken', False)
      if (nextToken):
        response = ssm.get_parameters_by_path(Path = ssmPath, NextToken = nextToken)

    ssmCache[ssmPath] = values

  val = ssmCache[ssmPath].get(valName, None)
  return val

def getValue(path):
  return globals().get(path, None)

def getOrig(val):
  return val

def getEnvironmentVariables(envValues):
  print("Get environment values ...")
  values = {}
  for val in envValues:
    search = re.search(r'\$\{(.*)}', envValues[val], flags=0)
    if (not search):
      values[val] = envValues[val]
      continue
    tpl = search.group(1)
    parts = tpl.split('://')
    try:
      path = parts[1]
      source = parts[0]
    except:
      path = parts[0]
      source = 'orig'
    parsedPath = Template(path).substitute(region = region, testMode = testMode)
    handlerBySource = {
      'credstash': getCredstashValue,
      'env': getEnvValue,
      'ssm': getSsmValue,
      'val': getValue,
      'orig': getOrig
    }.get(source, None)

    value = handlerBySource(parsedPath)
    if (value is not None):
      values[val] = envValues[val].replace('${' + tpl + '}', value)

  return values

def deployEcs(apiVersion, serviceDeploymentPath, fullSeviceName, serviceName, appVersion, serviceVersion, serviceTimeOut, serviceMemorySize, envValues, npmRegistry):
  return ''

def addToWarmUp(functionName, functionARN):
  print("Add to warm up " + functionARN + " ...")
  warmUpJSON = '{ "source": "seamlesspay-warm-up" }'
  events = boto3.client('events', region_name = region, endpoint_url = eventsEndoint)
  ruleName = 'warm-up-' + functionName
  try:
    rule = events.describe_rule(
        Name=ruleName
    )
  except:
    rule = events.put_rule(
      Name=ruleName,
      ScheduleExpression='cron(0/5 * * * ? *)',
      State='ENABLED'
    )

  events.enable_rule(
      Name=ruleName
  )

  print(rule)
  events.put_targets(
    Rule=ruleName,
    Targets=[
      {
        'Id': functionName,
        'Arn': functionARN,
        'Input': warmUpJSON
      }
    ]
  )

  try:
    lambdaFunc.add_permission(
      FunctionName=functionName,
      StatementId=ruleName,
      Action='lambda:InvokeFunction',
      Principal='events.amazonaws.com',
      SourceArn=rule['Arn']
    )
  except:
    pass


def deployLambda(apiVersion, serviceDeploymentPath, fullSeviceName, serviceName, appVersion, serviceVersion, serviceTimeOut, serviceMemorySize, envValues, npmRegistry):
  print("Deploy lambda function " + serviceName + "-" + apiVersion + " ...")
  lambdaPackage = json.loads(open(__dirName + '/templates/lambda/package.json.tpl', 'r').read())
  lambdaPackage['dependencies'] = {
    '@seamlesspay/application': appVersion,
    "mongoose": "5.7.7",
    '@seamlesspay/database-versioning': '1.0.0',
    '@seamlesspay/constants': '1.0.0',
    '@seamlesspay/errors': '1.0.0',
    '@seamlesspay/storage': '1.0.0',
    '@seamlesspay/lambda-feathers': '1.0.0',
    fullSeviceName: serviceVersion
  }
  os.system('mkdir -p ' + serviceDeploymentPath + '/src')
  json.dump(lambdaPackage, open(serviceDeploymentPath + '/src/package.json', 'w'), indent=2)
  os.system('find ' + serviceDeploymentPath + ' -name __tests__ -type d -exec rm -rf \'{}\' \'+\' ')
  os.system('find ' + serviceDeploymentPath + ' -name \'aws-sdk\' -type d -exec rm -rf \'{}\' \'+\' ')
  os.system('cd ' + serviceDeploymentPath + '/src; npm i  --no-audit --prefer-offline --production' + npmRegistry)
  handlerContext = Template(open(__dirName + '/templates/lambda/handler.js.tpl', 'r').read()).substitute(serviceName = fullSeviceName, env = env)

  open(serviceDeploymentPath + '/src/index.js', 'w').write(handlerContext)
  print("Making archive ... ")
  make_archive(serviceDeploymentPath + '/lambda', 'zip', root_dir=serviceDeploymentPath + '/src')
  functionName = serviceName + '-' + apiVersion
  try:
    print('Try to update function code ...')
    response = lambdaFunc.update_function_code(
      FunctionName=functionName,
      ZipFile=open(serviceDeploymentPath + '/lambda.zip', 'rb').read()
    )
    lambdaFunc.update_function_configuration(
      FunctionName=functionName,
      Runtime='nodejs10.x',
      Timeout=serviceTimeOut,
      MemorySize=serviceMemorySize,
      VpcConfig=getVpcConfig(),
      Environment={
        'Variables': getEnvironmentVariables(envValues)
      }
    )
  except:
    print('Create function ...')
    response = lambdaFunc.create_function(
      FunctionName=functionName,
      Runtime='nodejs10.x',
      Role=serviceRoleArn,
      Handler='index.handler',
      Code={
          'ZipFile': open(serviceDeploymentPath + '/lambda.zip', 'rb').read()
      },
      Description='string',
      Timeout=serviceTimeOut,
      MemorySize=serviceMemorySize,
      Publish=True,
      VpcConfig = getVpcConfig(),
      TracingConfig={
        'Mode': 'Active'
      },
      Environment={
        'Variables': getEnvironmentVariables(envValues)
      }
    )

  os.system('rm -rf ' + serviceDeploymentPath)

  functionARN = response['FunctionArn']

  # addToWarmUp(functionName, functionARN)

  return functionARN


def getRestApiID(apiName):
  print("Get REST API ID ...")
  restApiList = apiGateway.get_rest_apis()
  restApi = [x for x in restApiList['items'] if x['name'] == apiName][0]
  return restApi.get('id', False)

def getWebsocketApiID(apiName):
  if (local):
    return ''
  print("Get Websocket API ID ...")
  apiList = apiGatewayV2.get_apis()
  try:
    api = [x for x in apiList['Items'] if x['Name'] == apiName][0]
  except:
    api = {}
  return api.get('id', False)

def getResourceID(apiID, path):
  print("Get Resource ID for " + path + " ...")
  resourcePath = path
  sleep(2)
  resources = apiGateway.get_resources(restApiId = apiID, limit = 500)
  try:
    resource = [x for x in resources['items'] if x['path'] == resourcePath][0]
    resourceID = resource['id']
  except:
    print("Create Resource for " + path + " ...")
    pathParts = (resourcePath[1:] if resourcePath.startswith('/') else resourcePath).split('/')
    root = [x for x in resources['items'] if x['path'] == '/'][0]
    resourceID = root['id']


    for part in pathParts:
      try:
        resource = apiGateway.create_resource(
          restApiId=apiID,
          parentId=resourceID,
          pathPart=part
        )
        resourceID = resource['id']
      except:
        resource = [x for x in resources['items'] if x.get('parentId','') == resourceID and part in x.get('path','').split('/')][0]
        resourceID = resource['id']

  if (resource['path'] != resourcePath):
    print("\nERROR: Resource path " + resource['path'] + " is not equal " + resourcePath + "\n")
    exit(1)

  return resourceID

def putMethods(apiID, resourceID, methods, versions, cors):
  putVersionsForResource(resourceID, versions)
  for method in methods:
    try:
      apiGateway.delete_method(
        restApiId=apiID,
        resourceId=resourceID,
        httpMethod=method
      )
    except:
      pass
    versionHandlerARN = getVersionHandlerARN()
    # requestJson = Template(open(__dirName + '/templates/api-gateway/request.tpl', 'r').read()).safe_substitute(versions = json.dumps(versions), env = env)
    # responseJson = open(__dirName + '/templates/api-gateway/response.tpl', 'r').read()
    if(cors):
      responseParameters = {
        "method.response.header.Access-Control-Allow-Headers": True,
        "method.response.header.Access-Control-Allow-Methods": True,
        "method.response.header.Access-Control-Allow-Origin": True,
        "method.response.header.Access-Control-Allow-Credentials": True
      }
      integrationParameters = {
        "method.response.header.Access-Control-Allow-Headers": "'*'",
        "method.response.header.Access-Control-Allow-Methods": "'OPTIONS,POST,GET,PUT,DELETE'",
        "method.response.header.Access-Control-Allow-Origin": "'*'",
        "method.response.header.Access-Control-Allow-Credentials": "'false'"
      }
    else:
      responseParameters = {}
      integrationParameters = {}

    apiGateway.put_method(
      restApiId=apiID,
      resourceId=resourceID,
      httpMethod=method,
      authorizationType='NONE', #TODO: change to custom
      requestModels={
        'application/json': 'Empty'
      }
    )
    apiGateway.put_integration(
      restApiId = apiID,
      resourceId = resourceID,
      httpMethod = method,
      type = 'AWS_PROXY', #'HTTP'|'AWS'|'MOCK'|'HTTP_PROXY'|'AWS_PROXY'
      integrationHttpMethod = 'POST',
      uri = 'arn:aws:apigateway:' + region + ':lambda:path/2015-03-31/functions/' + versionHandlerARN + '/invocations',
      # uri = versionHandlerARN,
      # connectionType = 'INTERNET',
      # connectionId='string',
      credentials=apiToLambdaFunctionRole,
      # requestParameters={
      #   'versions': json.dumps(versions)
      # },
      # requestTemplates = {
      #   'application/json': requestJson
      # },
      passthroughBehavior = 'WHEN_NO_TEMPLATES',
      # cacheNamespace='string',
      cacheKeyParameters = [],
      # contentHandling='CONVERT_TO_BINARY'|'CONVERT_TO_TEXT',
      timeoutInMillis = 29000
    )

    apiGateway.put_method_response(
      restApiId = apiID,
      resourceId = resourceID,
      httpMethod = method,
      statusCode = '200',
      responseParameters = responseParameters,
      responseModels = {
        "application/json": "Empty"
      }
    )

    # apiGateway.put_integration_response(
    #   restApiId = apiID,
    #   resourceId = resourceID,
    #   httpMethod = method,
    #   statusCode = '200',
    #   responseParameters = integrationParameters,
    #   responseTemplates = {
    #     "application/json": responseJson
    #   }
    # )
  #end for
  try:
    apiGateway.delete_method(
      restApiId=apiID,
      resourceId=resourceID,
      httpMethod='OPTIONS'
    )
  except:
    pass
  if (cors):
    print("Put CORS integration")
    try:
      apiGateway.put_method(
        restApiId = apiID,
        resourceId = resourceID,
        httpMethod = 'OPTIONS',
        authorizationType = 'NONE',
        requestModels= {
          'application/json': 'Empty'
        }
      )
      apiGateway.put_integration(
        restApiId = apiID,
        resourceId = resourceID,
        httpMethod = 'OPTIONS',
        type = 'MOCK',
        requestTemplates = {
          'application/json': '{"statusCode": 200}'
        },
        passthroughBehavior = 'WHEN_NO_TEMPLATES',
        cacheKeyParameters = [],
        timeoutInMillis = 29000
      )
      apiGateway.put_method_response(
        restApiId = apiID,
        resourceId = resourceID,
        httpMethod = 'OPTIONS',
        statusCode = '200',
        responseModels = {
          "application/json": "Empty"
        },
        responseParameters = responseParameters

      )

      apiGateway.put_integration_response(
        restApiId = apiID,
        resourceId = resourceID,
        httpMethod = 'OPTIONS',
        statusCode = '200',
        responseTemplates = {
          "application/json": ""
        },
        responseParameters = integrationParameters
      )
    except:
      pass

def updateApiGatewayResources(apiNames, paths, deploymentType, versions, cors = True):
  print('updateApiGatewayResources')
  print(apiNames)
  for apiName in apiNames:
    try:
      apiID = getRestApiID(apiName)
      apiType = 'REST'
    except:
      apiID = getWebsocketApiID(apiName)
      apiType = 'WEBSOCKET'
    if (not apiID):
      print("\nERROR: API " + apiName + " doesn't exist in region " + region + "\n")
      exit(1)
    print("apiType = " + apiType)
    if (apiType == 'REST'):
      for path in paths:
        resourceID = getResourceID(apiID = apiID, path = path)
        methods = paths[path]
        print("Put methods for " + path + " ...")
        putMethods(apiID = apiID, resourceID = resourceID, methods = methods, versions = versions, cors = cors)

    #TODO: Update websocket api
  return apiNames

def unsupportTypeException(deploymentType):
  def exception(**kwors):
    print("\nERROR: Deployment type " + deploymentType + " unsupported\n")
    exit(1)
  return exception

def deployService(servicePackage):
  print("Deploy module " + servicePackage['name'] + " ...")
  try:
    serviceConfig = servicePackage['service']
  except:
    print("\nERROR: Service doesn't configured\n")
    exit(1)
  if (isOpen('localhost', 4873)):
    npmRegistry = ' --registry http://localhost:4873'
  else:
    npmRegistry = ''
  versions = serviceConfig['versions']
  paths = serviceConfig['paths']
  apiNames = serviceConfig.get('apiNames', defaultDeploymentConfig['apiNames'])
  serviceVersions = {}
  for apiVersion in versions:
    if (apiVersion not in allVersions):
      print("\nERROR: Version " + apiVersion + " doesn't exists in " + rootDir + "/versions.json\n")
      exit(1)

    versionConfig = versions[apiVersion]
    serviceVersion = versionConfig['serviceVersion']
    appVersion = versionConfig.get('appVersion', defaultAppVersion)
    fullSeviceName = versionConfig.get('serviceModuleName', servicePackage['name'])
    serviceName = fullSeviceName.replace('@seamlesspay/','')
    serviceTimeOut = versionConfig.get('timeOut', defaultServiceTimeOut)
    serviceMemorySize = versionConfig.get('memorySize', defaultServiceMemorySize)
    envValues = versionConfig.get('envValues', serviceConfig.get('envValues', {}))
    serviceDeploymentPath = deploymentPath + serviceName + '-' + apiVersion

    deployConfig = versionConfig.get('deployment', defaultDeploymentConfig)
    deploymentType = deployConfig.get('type', defaultDeploymentConfig['type'])

    deployByType = {
      'lambda': deployLambda,
      'container': deployEcs
    }
    deploy = deployByType.get(deploymentType, unsupportTypeException(deploymentType))
    serviceHandler = deploy(
        apiVersion = apiVersion,
        serviceDeploymentPath = serviceDeploymentPath,
        fullSeviceName = fullSeviceName,
        serviceName = serviceName,
        appVersion = appVersion,
        serviceVersion = serviceVersion,
        serviceTimeOut = serviceTimeOut,
        serviceMemorySize = serviceMemorySize,
        envValues = envValues,
        npmRegistry = npmRegistry
      )

    serviceVersions[apiVersion] = {
      'type': deploymentType,
      'handler': serviceHandler
    }
  #end for

  apiGatewayVersions = {}
  currentVersion = { 'type': 'unavailable' }
  sortedVersionsKeys = sorted(allVersions.keys(), key=lambda x: datetime.datetime.strptime(x, '%Y-%m-%d'))
  for versionkey in sortedVersionsKeys:
    apiGatewayVersions[versionkey] = serviceVersions.get(versionkey, currentVersion)
    currentVersion = apiGatewayVersions[versionkey]

  apiGatewayVersions['default'] = apiGatewayVersions.get(defaultVersion, currentVersion)

  updateApiGatewayResources(
    apiNames = apiNames,
    paths = paths,
    deploymentType = deploymentType,
    versions = apiGatewayVersions
  )
  print("Service " + serviceName + " was successfully deployed!")

deployService(servicePackage)
