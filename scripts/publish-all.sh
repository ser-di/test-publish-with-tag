#!/usr/bin/env bash

root=$PWD

# echo "[PUBLISH ALL] Restart verdaccio:"
docker stop verdaccio
docker run -d --rm --name verdaccio -p 4873:4873 verdaccio/verdaccio
echo '' > ~/.npmrc
sleep 1
node ./scripts/npm-login.js
npm set //localhost:4873/:_authToken $(sed 's/\/\/localhost:4873\/:_authToken=//g' ~/.npmrc)
sleep 1

set -e
find . -name yarn-error.log -type f -delete
find . -name coverage -type d -exec rm -rf '{}' '+'
find . -name package-lock.json 

for d in $root/packages/*/; do
  cd $d
  echo $d
  npm publish --registry http://localhost:4873
done

for d in $root/services/*/; do
  cd $d
  echo $d
  npm publish --registry http://localhost:4873
done