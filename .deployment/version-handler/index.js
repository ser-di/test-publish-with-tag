const https = require('https')
const { Lambda, S3 } = require('aws-sdk')
const qs = require('querystring')
const lambda = new Lambda()
const versionsS3Bucket = 'seamlesspay-versioning'
const s3 = new S3()

exports.handler = async (event) => {
  console.log('event: ', JSON.stringify(event))
  const {
    path: servicePath,
    pathParameters: pathParams = {},
    source,
    multiValueQueryStringParameters,
    headers = {},
    body,
    requestContext,
    form,
    httpMethod
  } = event
  if (source === 'seamlesspay-warm-up') return
  const path = Object.keys(pathParams || {}).reduce(
    (result, paramName) => result.replace(`{${paramName}}`, pathParams[paramName])
    , servicePath
  )

  const version = headers['Accepted-Version'] || headers['accepted-version'] || headers['version']
  const { resourceId } = requestContext
  const versions = await s3.getObject({ Bucket: versionsS3Bucket, Key: `api-gateway/${resourceId}.cfg` }).promise().then(data => JSON.parse(data.Body.toString()))

  const versionConfig = versions[version] || (!version && versions.default)
  const querystring = qs.stringify(multiValueQueryStringParameters)

  if (!versionConfig)
    return {
      statusCode: 422,
      body: JSON.stringify({
        "name": "Unprocessable",
        "message": "Unsupported version",
        "code": 422,
        "className": "unprocessable"
      })
    }
  const { type = 'lambda', handler } = versionConfig
  const payload = event
  const handlerByType = {
    lambda:
      (event) => lambda.invoke({
        FunctionName: handler,
        Payload: JSON.stringify(payload)
      })
      .promise()
      .then(({ StatusCode, Payload }) => {
        if (StatusCode !== 200)
          return {
            statusCode: 500,
            body: '{"message": "System Error"}'
          }
        const payload = JSON.parse(Payload)
        if (payload.errorMessage)
          return {
            statusCode: 500,
            body: Payload
          }

        return payload
      }),
    container:
      (event) => new Promise((resolve, reject) => {
        const { path, httpMethod, headers, port = 443, body, querystring = '' } = event
          const options = {
            hostname: handler,
            port,
            path: `${path}?${querystring}`,
            method: httpMethod,
            headers,
            rejectUnauthorized: false,
            requestCert: true,
            agent: false
          }

          const req = https.request(options, (res) => {
            let data = ''

            res.on('data', (chunk) => {
              data += chunk
            })

            res.on('end', () => {
              resolve({
                statusCode: res.statusCode,
                body: data,
                headers: res.headers
              })
            })
          })

          req.on('error', (error) => {
            reject({
                statusCode: 200,
                body: JSON.stringify(error)
              })
          })
          if (httpMethod !== 'GET')
            req.write(body)
          req.end()
      })
  }
  const serviceHandler = handlerByType[type]
  const response = await serviceHandler(event)
  console.log('response: ', response)
  return { ...response, headers: { ...response.headers, ...corsHeaders } }
}
