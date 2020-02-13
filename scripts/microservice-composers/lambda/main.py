import json
import yaml
import copy
import shutil
from string import Template
from os import listdir, makedirs
from os.path import isdir, join

services_path='./services'
function_path_template='./functions/ps-service-$service_name'

services = [d for d in listdir(services_path) if isdir(join(services_path, d))]
# services = ['merchant-secrets']

microservices_configs = yaml.load(open('./microservices.yml', 'r').read())

# read lambda template
lambda_template = {
    'package': json.loads(open('./scripts/microservice-composers/lambda/template/package.json', 'r').read()),
    'handler': open('./scripts/microservice-composers/lambda/template/handler.js', 'r').read(),
    'serverless_config': yaml.load(open('./scripts/microservice-composers/lambda/template/serverless.yml', 'r').read())
}

microservices = {}
for service_name in services:
    service_pack = json.loads(open('./services/' + service_name + '/package.json', 'r').read())
    # ignore non deployable services
    if not ('deployConfig' in service_pack) or ('deployConfig' in service_pack and not str(service_pack['deployConfig']['type']) == 'lambda'):
        continue

    microservice_name = service_name if not (
        'microservice' in service_pack['deployConfig']
    ) else service_pack['deployConfig']['microservice']
    dependent_services = [
        dependent_service.replace('@seamlesspay/service-', '') for dependent_service in service_pack['dependencies'] if dependent_service.startswith('@seamlesspay/service-') == True
    ]

    if not microservice_name in microservices:
        microservices[microservice_name] = {
            'services': [service_name],
            'config': next(
                (config for config in microservices_configs if str(config['name']) == microservice_name), 
                {
                    'port': 8585,
                    'use-express': 'false'
                }
            )
        }
    else:
        microservices[microservice_name]['services'].append(service_name)

    microservices[microservice_name]['services'] = list(set(microservices[microservice_name]['services'] + dependent_services))

for microservice in microservices:
    microservice = str(microservice)
    config =  microservices[microservice]['config']

    # remove old lambda directory
    try:
        shutil.rmtree(Template(function_path_template).substitute(service_name=microservice))
    except: 
        pass

    # create lambda service package
    service_package = copy.deepcopy(lambda_template['package'])
    service_package['name'] = Template(service_package['name']).substitute(service_name=microservice) 
    service_package['repository'] = Template(service_package['repository']).substitute(service_name=microservice)
    dependencies = []
    for service_name in microservices[microservice]['services']:
        dependency = '@seamlesspay/service-' + service_name
        dependencies.append(dependency)
        service_package['dependencies'][dependency] = '*'
    if config['use-express'] == 'true':
        service_package['dependencies']['body-parser'] = '1.18.3'
        service_package['dependencies']['@feathersjs/express'] = '1.2.3'

    # create lambda
    service_lambda_path = Template(function_path_template).substitute(service_name=microservice)
    try:
        makedirs(service_lambda_path)
    except FileExistsError:
        pass
    
    service_path = ',\n  path: \'' + microservice + '\'' if len(dependencies) == 1 else ''
    require_services = ['require(\'' + dependency + '\')' for dependency in dependencies]

    json.dump(service_package, open(service_lambda_path + '/package.json', 'w'), indent=2)
    open(service_lambda_path + '/handler.js', 'w').write(
        Template(
            lambda_template['handler']
        ).substitute(
            require_services='\n'.join(require_services), 
            path=service_path,
            use_express=config['use-express'],
            port=config['port']
        )
    )
    service_lambda_serverless_config = copy.deepcopy(lambda_template['serverless_config'])
    service_lambda_serverless_config['service'] = Template(
        service_lambda_serverless_config['service']
    ).substitute(service_name=microservice)

    yaml.dump(
        service_lambda_serverless_config, 
        open(service_lambda_path + '/serverless.yml', 'w'), 
        default_flow_style=False, 
        allow_unicode=True,
        indent=2
    ) 
