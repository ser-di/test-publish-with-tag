import boto3
region = 'us-east-2'
warmUpJSON = '{ "source": "seamlesspay-warm-up" }'

events = boto3.client('events', region_name = region)

try:
  events.describe_rule(
      Name='warm-up'
  )
except:
  events.put_rule(
    Name='warm-up',
    ScheduleExpression='cron(0/5 * * * ? *)',
    State='ENABLED',
  )

response = events.put_targets(
  Rule='warm-up',
  Targets=[
    {
      'Id': 'service-web-webhooks-2019-09-01',
      'Arn': 'arn:aws:lambda:us-east-2:325127086676:function:service-web-webhooks-2019-09-01',
      'Input': warmUpJSON
    }
  ]
)
print(response)