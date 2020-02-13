rm -rf package-lock.json
rm -rf node_modules/
npm i --registry http://localhost:4873 --production
rm -rf node_modules/aws-sdk
du -d 1 -h