#!/usr/bin/env bash

for f in $(ls ./functions)
do 
  echo TEST FUNCTION $f
  export root=$PWD
  cd ./functions/$f
  yarn test
  cd $root
done