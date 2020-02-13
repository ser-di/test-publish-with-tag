#!/bin/bash

root=$PWD
set -e

for d in $root/services/*/; do
  cd $d
  echo deploy $1 $d
  yarn "deploy:$1"
done
