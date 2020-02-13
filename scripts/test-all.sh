root=$PWD
set -e

lerna clean --yes
yarn

for d in $root/packages/*/; do
  echo START TEST FOR $d
  cd $d
  echo $d
  yarn test
  echo TEST FOR $d ENDED
done

for d in $root/services/*/; do
  echo START TEST FOR $d
  cd $d
  echo $d
  yarn test
  echo TEST FOR $d ENDED
done
