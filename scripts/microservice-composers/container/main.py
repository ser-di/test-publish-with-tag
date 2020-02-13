import json
import yaml
import copy
import shutil
from string import Template
from os import listdir, makedirs
from os.path import isdir, join

services_path='./services'
container_path_template='./containers/ps-service-$service_name'

services = [d for d in listdir(services_path) if isdir(join(services_path, d))]
# services = ['merchant-secrets']

microservices_configs = yaml.load(open('./microservices.yml', 'r').read())

# read container template
container_template = {
    'package': json.loads(open('./scripts/microservice-composers/container/template/package.json', 'r').read()),
    'handler': open('./scripts/microservice-composers/container/template/index.js', 'r').read(),
    'dockerfile': open('./scripts/microservice-composers/container/template/.deployment/Dockerfile', 'r').read(),
    'docker-dependencies': open('./scripts/microservice-composers/container/template/.deployment/docker-dependencies.sh', 'r').read(),
    'deployment': open('./scripts/microservice-composers/container/template/.deployment/deployment.sh', 'r').read(),
    'config': open('./scripts/microservice-composers/container/template/.deployment/.config.json', 'r').read()
}

microservices = {}
for service_name in services:
    service_pack = json.loads(open('./services/' + service_name + '/package.json', 'r').read())
    # ignore non deployable services
    if not ('deployConfig' in service_pack) or ('deployConfig' in service_pack and not str(service_pack['deployConfig']['type']) == 'container'):
        continue

    microservice_name = service_name if not (
        'microservice' in service_pack['deployConfig']
    ) else service_pack['deployConfig']['microservice']
    
    if not microservice_name in microservices:
        microservices[microservice_name] = {
            'services': [service_name],
            'config': next(
                (config for config in microservices_configs if str(config['name']) == microservice_name), 
                {  
                    'port': 3030, 
                    'ecs-cluster': str(microservice_name).upper(),
                    'ecs-service': microservice_name.upper() 
                }
            )
        }
    else:
        microservices[microservice_name]['services'].append(service_name)

for microservice in microservices:
    microservice = str(microservice)
    # remove old container directory
    try:
        shutil.rmtree(Template(container_path_template).substitute(service_name=microservice))
    except: 
        pass

    # create service container package
    service_package = copy.deepcopy(container_template['package'])
    service_package['name'] = Template(service_package['name']).substitute(service_name=microservice) 
    service_package['repository'] = Template(service_package['repository']).substitute(service_name=microservice)
    dependencies = []
    for service_name in microservices[microservice]['services']:
        dependency = '@seamlesspay/service-' + service_name
        dependencies.append(dependency)
        service_package['dependencies'][dependency] = '*'

    # create container
    service_container_path = Template(container_path_template).substitute(service_name=microservice)
    service_container_deployment_path = service_container_path + '/.deployment'
    try:
        makedirs(service_container_path)
        makedirs(service_container_deployment_path)
    except FileExistsError:
        pass
    
    open(service_container_deployment_path + '/deployment.sh', 'w').write(container_template['deployment'])
    open(service_container_deployment_path + '/docker-dependencies.sh', 'w').write(container_template['docker-dependencies'])
    open(service_container_deployment_path + '/Dockerfile', 'w').write(container_template['dockerfile'])
    open(service_container_deployment_path + '/.config.json', 'w').write(
        Template(
            container_template['config']
        ).substitute(
            MICROSERVICE_NAME=microservices[microservice]['config']['name'],
            AWS_ECS_SERVICE_NAME=microservices[microservice]['config']['ecs-service'],
            AWS_ECS_CLUSTER_NAME=microservices[microservice]['config']['ecs-cluster']
        )
    )

    json.dump(service_package, open(service_container_path + '/package.json', 'w'), indent=2)
    open(service_container_path + '/index.js', 'w').write(
        Template(
            container_template['handler']
        ).substitute(
            port=microservices[microservice]['config']['port'],
            microservice_name=microservice
        )
    )
