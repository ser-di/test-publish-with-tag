#!/bin/bash
# more bash-friendly output for jq
JQ="jq --raw-output --exit-status"

AWS_ACCOUNT_ID=$(aws sts get-caller-identity --output text --query 'Account')
MICROSERVICE_NAME=$($JQ '.microservice' .config.json)
SERVICE_NAME=$($JQ  -r '."aws-ecs-service"' .config.json)
CLUSTER_NAME=$($JQ  -r '."aws-ecs-cluster"' .config.json)
BUILD_NUMBER=${CIRCLE_SHA1:-latest}

DOCKER_TAG=seamlesspay/${MICROSERVICE_NAME}:${BUILD_NUMBER}
DOCKER_TAG_LATEST=seamlesspay/${MICROSERVICE_NAME}:latest
TASK_FAMILY=CLUSTER_NAME

DEP_FOLDER=.deployment
AWS_REGION=${1}

API_CI_AWS_ACCESS_KEY_ID=$(credstash -r us-east-1 -t sp-project get aws_key)
API_CI_AWS_SECRET_ACCESS_KEY=$(credstash -r us-east-1 -t sp-project get aws_secret)

if [ "${2}" == "test_mode" ]
then
  TEST_COMMAND="ENV TEST_MODE=true"
else
  TEST_COMMAND=""
fi

configure_aws_cli(){
  aws --version
  aws configure set default.region ${AWS_REGION}
  aws configure set default.output json
}

build() {
  # Build docker container
  sed "s;%AWS_REGION%;${AWS_REGION};g;s;%TEST_MODE%;${TEST_COMMAND};g;" ${DEP_FOLDER}/Dockerfile > ${DEP_FOLDER}/Dockerfile.conf
  docker build --rm=false -t "${DOCKER_TAG}" -f ${DEP_FOLDER}/Dockerfile.conf .
}

push_ecr_image() {
  $(aws ecr get-login --no-include-email --region ${AWS_REGION})
  ecr_image=${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${DOCKER_TAG}
  docker tag ${DOCKER_TAG} ${ecr_image}
  docker push ${ecr_image}

  ecr_image_latest=${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${DOCKER_TAG_LATEST}
  # infrastruction uses latest tag for task definition
  if [[ "${DOCKER_TAG}" != "${DOCKER_TAG_LATEST}" ]]; then
    docker tag ${DOCKER_TAG} ${ecr_image_latest}
    docker push ${ecr_image_latest}
  fi
  docker logout
}

deploy_cluster() {
  make_task_def
  register_definition

  if [[ $(aws ecs update-service --cluster ${CLUSTER_NAME} --service ${SERVICE_NAME} --task-definition "$revision" | \
         $JQ '.service.taskDefinition') != $revision ]]; then

   echo "Error updating service."
   return 1
  fi

  return 0
}

make_task_def() {
    container_definition_x_ray=$($JQ "
        (.\"container-definitions\".\"x-ray\".image = \"'${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/seamlesspay/x-ray-sidecar:latest'\") |
        (.\"container-definitions\".\"x-ray\".logConfiguration.options.\"awslogs-region\" = \"'${AWS_REGION}'\") |
        (.\"container-definitions\".\"x-ray\".environment[] | select(.name == \"AWS_ACCESS_KEY_ID\") | .value) |= \"'${API_CI_AWS_ACCESS_KEY_ID}'\" |
        (.\"container-definitions\".\"x-ray\".environment[] | select(.name == \"AWS_SECRET_ACCESS_KEY\") | .value) |= \"'${API_CI_AWS_SECRET_ACCESS_KEY}'\" |
        .\"container-definitions\".\"x-ray\"
    " .config.json)

    container_definition_service=$($JQ "
        (.\"container-definitions\".\"${MICROSERVICE_NAME}\".image = \"'${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/$DOCKER_TAG'\") |
        (.\"container-definitions\".\"${MICROSERVICE_NAME}\".logConfiguration.options.\"awslogs-region\" = \"'${AWS_REGION}'\") |
        (.\"container-definitions\".\"${MICROSERVICE_NAME}\".environment[] | select(.name == \"AWS_ACCESS_KEY_ID\") | .value) |= \"'${API_CI_AWS_ACCESS_KEY_ID}'\" |
        (.\"container-definitions\".\"${MICROSERVICE_NAME}\".environment[] | select(.name == \"AWS_SECRET_ACCESS_KEY\") | .value) |= \"'${API_CI_AWS_SECRET_ACCESS_KEY}'\" |
        .\"container-definitions\".\"${MICROSERVICE_NAME}\"
    " .config.json)

	task_def="[
        ${container_definition_x_ray},
        ${container_definition_service}
    ]"
}

register_definition() {

    if revision=$( aws ecs register-task-definition \
      --container-definitions "$task_def" \
      --family "${TASK_FAMILY}" \
      --network-mode awsvpc \
      --task-role-arn arn:aws:iam::325127086676:role/ApiInstanceRole \
      --execution-role-arn arn:aws:iam::325127086676:role/ApiInstanceRole \
      --requires-compatibilities FARGATE \
      --cpu 1024 \
      --memory 2048 | $JQ '.taskDefinition.taskDefinitionArn'); then
        echo "Revision: $revision"
    else
        echo "Failed to register task definition"
        return 1
    fi

}

configure_aws_cli
build
push_ecr_image
deploy_cluster
