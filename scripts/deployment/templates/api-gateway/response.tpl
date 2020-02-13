#set($inputRoot = $input.path('$'))
#set($context.responseOverride.status = $inputRoot.get('statusCode'))
#set($headers =  $inputRoot.get('headers'))
#foreach($header in $headers.keySet())
#set($context.responseOverride.header[$header] = $headers.get($header))
#end
$inputRoot.get('body')