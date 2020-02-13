#!/usr/bin/env bash

for name in $(aws events list-rules --name-prefix "warm-up" --region us-east-1 | jq '.Rules[].Name' --raw-output)
do
    TARGETS=$(aws events list-targets-by-rule --rule $name --region us-east-1 )
    Id=$(echo $TARGETS | jq '.Targets[0].Id' --raw-output)
    Arn=$(echo $TARGETS | jq '.Targets[0].Arn' --raw-output)
    Input='{ \"source\": \"seamlesspay-warm-up\", \"env\": \"live\" }'
    aws events  put-targets --rule $name --targets "[{\"Id\":\"$Id\", \"Arn\": \"$Arn\", \"Input\": \"$Input\" }]" --region us-west-2
done

for name in $(aws events list-rules --name-prefix "warm-up" --region us-west-2 | jq '.Rules[].Name' --raw-output)
do
    aws events put-rule --name $name --schedule-expression "cron(*/5 * * * ? *)" --state ENABLED --region us-west-2
done

for name in $(aws lambda list-functions --region us-west-2 | jq '.Functions[].FunctionName' --raw-output)
do
    if [[ $name == "service-"* ]]
    then
        aws lambda  update-function-configuration --function-name $name --memory-size 1024 --runtime nodejs10.x --region us-west-2
    fi
done
