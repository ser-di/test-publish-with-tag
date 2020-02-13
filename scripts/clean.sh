#!/usr/bin/env bash
MODE=${1:-'lerna'}

if [ "${MODE}" == "lerna" ]
then
    rm -rf ./node_modules
    lerna exec --parallel \
        -- rm -rf ./node_modules \
        -- rm -rf ./lib \
        -- rm -rf ./yarn-error.log \
        -- rm -rf ./.serverless;
fi

if [ "${MODE}" == "find" ]
then
    find . -type d -name 'node_modules' -exec rm -rf {} \;
    find . -type d -name 'lib' -exec rm -rf {} \;
    find . -type f -name 'yarn-error.log' -exec rm -rf {} \;
    find . -type d -name '.serverless' -exec rm -rf {} \;
fi
