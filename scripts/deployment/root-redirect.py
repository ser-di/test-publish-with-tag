import boto3

defaultRegion = 'us-east-2'
apiName = 'API-REST'

try:
  region = sys.argv[1]
except:
  region = defaultRegion

apiGateway = boto3.client('apigateway', region_name = region)
restApiList = apiGateway.get_rest_apis()
restApi = [x for x in restApiList['items'] if x['name'] == apiName][0]
apiID = restApi.get('id')

resources = apiGateway.get_resources(restApiId = apiID, limit = 500)
root = [x for x in resources['items'] if x['path'] == '/'][0]
rootID = root['id']

try:
  apiGateway.delete_method(
    restApiId=apiID,
    resourceId=rootID,
    httpMethod='ANY'
  )
except:
  pass

# try:
apiGateway.put_method(
  restApiId=apiID,
  resourceId=rootID,
  httpMethod='ANY',
  authorizationType='NONE' #TODO: change to custom
  # requestModels={
  #   'application/json': 'Empty'
  # }
)
apiGateway.put_integration(
  restApiId = apiID,
  resourceId = rootID,
  httpMethod = 'ANY',
  type = 'MOCK',
  requestTemplates = {
    "application/json": "{\"statusCode\": 301}",
  }
)

apiGateway.put_method_response(
  restApiId = apiID,
  resourceId = rootID,
  httpMethod = 'ANY',
  statusCode = '301',
  responseParameters = {"method.response.header.Location": True},
  responseModels = { 
    "application/json": "Empty" 
  }
)

apiGateway.put_integration_response(
  restApiId = apiID,
  resourceId = rootID,
  httpMethod = 'ANY',
  statusCode = '301',
  responseTemplates = {"application/json":" redirect"},
  responseParameters = { 
    "method.response.header.Location": "'"'https://www.seamlesspay.com'"'"
  }
)
# except:
#   pass

print(root)