const { mongoose } = require('@seamlesspay/database-versioning')
console.log('Connections before storage init: ', mongoose.connections.length)
const { getStorageConfig, setMongoConnection } = require('@seamlesspay/storage')
console.log('Connections after storage init: ', mongoose.connections.length)

const lambdaFeathers = require('@seamlesspay/lambda-feathers')
const getApp = require('@seamlesspay/application')
const { Unprocessable } = require('@seamlesspay/errors')
const { 
	STORAGE_CONSTANTS: { STORAGE_API: storageName },
	ERROR_CONSTANTS: { PAYMENT_SYSTEM_ERROR }
} = require('@seamlesspay/constants')
const service = require('$serviceName')
const env = '$env'

const { params: { uri: dbUri, options: dbOptions } } = getStorageConfig({ env, storageName })
console.log('dbOptions: ', dbOptions)

let dbConnection = null
let app = null

process.removeAllListeners('unhandledRejection')

exports.handler = async (event, context) => {
	console.log('Connections: ', mongoose.connections.length)
	try {
		context.callbackWaitsForEmptyEventLoop = false

		if(dbConnection === null) {
			console.log('Create connection')
			try {
				dbConnection = await mongoose.connect(dbUri, dbOptions)
				setMongoConnection(dbConnection)
				//dbConnection.on('error', err => console.log('Conection Error: ', err))
			} catch(error) {
				console.log('Conection Error: ', error)
			}
		}

		console.log('TRY TO GET User!')
		const user = await dbConnection.connections[0].collection('Merchants').findOne({})
		console.log('USER:', user)
	
		if (app === null) {
			console.log('Get App')
			app = getApp({ env, service })
			app.setup()
		}
	
		if (event.source === 'seamlesspay-warm-up') {
			console.log('warm up invocation')
			return {
				statusCode: 200,
        body: JSON.stringify('Warm UP Lambda!'),
			}
		}

		console.log('start service')
		const result = await lambdaFeathers(app, event, context)
		console.log('service result: ', result)

		return result
	} catch (error) {
		console.log('Lambda Error: ', error)
		return {
				statusCode: 500,
        body: new Unprocessable(PAYMENT_SYSTEM_ERROR, {
					statusCode: '911',
					statusDescription: 'Unknown Error'
				})
		}
	}
}
