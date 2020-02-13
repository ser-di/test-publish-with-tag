#!/usr/bin/env bash
stage=$1
for f in $(ls ./functions)
do 
  export root=$PWD
  cd ./functions/$f
  yarn deploy:$stage
  cd $root
done