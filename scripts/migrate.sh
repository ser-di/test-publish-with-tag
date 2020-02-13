#!/usr/bin/env bash

AWS_REGION=${1}

configure_aws_cli(){
	aws --version
	aws configure set default.region ${AWS_REGION}
	aws configure set default.output json
}

migrate_data() {
  echo "Start migrate for ${AWS_REGION}..."

  aws lambda invoke --function ps-migrate --region ${AWS_REGION} /tmp/aws.log
}

configure_aws_cli
migrate_data
