{
  "version": "$input.params('Accepted-Version')",
  "httpMethod": "$context.httpMethod",
  "body": "$util.escapeJavaScript($input.json('$'))",
  "headers": {
    #foreach($param in $input.params().header.keySet())
      "$param": "$util.escapeJavaScript($input.params().header.get($param))"
      #if($foreach.hasNext),#end
    #end
  },
  "servicePath": "$context.resourcePath",
  "pathParams": {
    #foreach($param in $input.params().path.keySet())
    "$param": "$util.escapeJavaScript($input.params().path.get($param))" #if($foreach.hasNext),#end

    #end
  },
  "querystring": "#foreach($key in $input.params().querystring.keySet())$util.urlEncode($key)=$util.urlEncode($input.params().querystring.get($key))#if($foreach.hasNext)&#end#end",
  "env": "$env",
  "versions": $versions,
  "stage-variables" : {
    #foreach($key in $stageVariables.keySet())
    "$key" : "$util.escapeJavaScript($stageVariables.get($key))"
        #if($foreach.hasNext),#end
    #end
  },
  "context" : {
    "account-id" : "$context.identity.accountId",
    "api-id" : "$context.apiId",
    "api-key" : "$context.identity.apiKey",
    "authorizer-principal-id" : "$context.authorizer.principalId",
    "caller" : "$context.identity.caller",
    "cognito-authentication-provider" : "$context.identity.cognitoAuthenticationProvider",
    "cognito-authentication-type" : "$context.identity.cognitoAuthenticationType",
    "cognito-identity-id" : "$context.identity.cognitoIdentityId",
    "cognito-identity-pool-id" : "$context.identity.cognitoIdentityPoolId",
    "stage" : "$context.stage",
    "source-ip" : "$context.identity.sourceIp",
    "user" : "$context.identity.user",
    "user-agent" : "$context.identity.userAgent",
    "user-arn" : "$context.identity.userArn",
    "request-id" : "$context.requestId",
    "resource-id" : "$context.resourceId",
    "resource-path" : "$context.resourcePath"
  }
}