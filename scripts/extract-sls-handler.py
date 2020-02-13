import yaml
from sys import argv, stdout

sls_config_file_path = argv[1]

sls_config = yaml.load(open(sls_config_file_path, 'r').read())
sls_service_name = sls_config['service']
aws_function_name = sls_service_name if len(argv) == 2 else argv[2]

handlers = [
    sls_config['functions'][function]['handler'] for function in sls_config['functions'] 
    if sls_config['functions'][function]['name'].replace('${self:service}', sls_service_name) == aws_function_name
]

print(handlers[0])
