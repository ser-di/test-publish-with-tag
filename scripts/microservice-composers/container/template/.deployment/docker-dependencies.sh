#!/bin/bash

apk update
apk add --no-cache \
  python \
  python-dev \
  python3-dev \
  py-pip \
  build-base \
  libffi-dev \
  openssl-dev \
  jq \
  gcc
pip install --upgrade pip
pip install --upgrade \
  awscli \
  docker-compose \
  credstash \
  cffi
