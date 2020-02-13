#!/usr/bin/env bash

root=$PWD
set -e

for d in $root/packages/*/; do
  echo check $d
  dependency-check --verbose --no-dev -i aws-sdk -i mysql2 -i migrate-mongo -i qs $d
done

for d in $root/services/*/; do
  echo check $d
  dependency-check --verbose --no-dev -i aws-sdk -i mysql2 -i migrate-mongo -i qs $d
done
