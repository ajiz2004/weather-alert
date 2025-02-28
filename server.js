require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { Pool } = require('pg');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(morgan('dev'));

// Database connection
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// Initialize database tables
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cities (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS weather_data (
        id SERIAL PRIMARY KEY,
        city_id INTEGER REFERENCES cities(id),
        temperature NUMERIC NOT NULL,
        weather_condition VARCHAR(100) NOT NULL,
        timestamp TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS alerts (
        id SERIAL PRIMARY KEY,
        city_id INTEGER REFERENCES cities(id),
        alert_type VARCHAR(50) NOT NULL,
        message TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT NOW()
      )
    `);
    
    console.log('Database tables initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

// Weather API functions
async function fetchWeatherData(city) {
  try {
    const response = await axios.get(
      `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&appid=${process.env.WEATHER_API_KEY}`
    );
    return response.data;
  } catch (error) {
    console.error(`Error fetching weather data for ${city}:`, error.message);
    return null;
  }
}

async function processWeatherData(weatherData, cityId, cityName) {
  if (!weatherData) return;

  const temperature = weatherData.main.temp;
  const weatherCondition = weatherData.weather[0].main;

  // Store weather data
  await storeWeatherData(cityId, temperature, weatherCondition);

  // Check alert conditions
  if (weatherCondition.toLowerCase().includes('rain')) {
    await createAlert(cityId, 'Rain', `Alert: Rain detected in ${cityName} at ${new Date().toISOString()}.`);
  }

  if (temperature > 30) {
    await createAlert(cityId, 'High Temperature', `Alert: High temperature (${temperature}°C) detected in ${cityName} at ${new Date().toISOString()}.`);
  }

  if (temperature < 10) {
    await createAlert(cityId, 'Low Temperature', `Alert: Low temperature (${temperature}°C) detected in ${cityName} at ${new Date().toISOString()}.`);
  }
}

// Database functions
async function storeWeatherData(cityId, temperature, weatherCondition) {
  try {
    await pool.query(
      'INSERT INTO weather_data (city_id, temperature, weather_condition) VALUES ($1, $2, $3)',
      [cityId, temperature, weatherCondition]
    );
  } catch (error) {
    console.error('Error storing weather data:', error);
  }
}

async function createAlert(cityId, alertType, message) {
  try {
    await pool.query(
      'INSERT INTO alerts (city_id, alert_type, message) VALUES ($1, $2, $3)',
      [cityId, alertType, message]
    );
    
    // Simulate user notification
    console.log(`NOTIFICATION: ${message}`);
  } catch (error) {
    console.error('Error creating alert:', error);
  }
}

async function getAllCities() {
  try {
    const result = await pool.query('SELECT * FROM cities');
    return result.rows;
  } catch (error) {
    console.error('Error fetching cities:', error);
    return [];
  }
}

// Main weather checking function
async function checkWeatherForAllCities() {
  console.log('Checking weather for all cities...');
  const cities = await getAllCities();
  
  for (const city of cities) {
    const weatherData = await fetchWeatherData(city.name);
    if (weatherData) {
      await processWeatherData(weatherData, city.id, city.name);
    }
  }
}

// API Routes
app.get('/weather', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.name as city, w.temperature, w.weather_condition, w.timestamp
      FROM weather_data w
      JOIN cities c ON w.city_id = c.id
      ORDER BY w.timestamp DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching weather data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/alerts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.name as city, a.alert_type, a.message, a.timestamp
      FROM alerts a
      JOIN cities c ON a.city_id = c.id
      ORDER BY a.timestamp DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching alerts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Get all cities endpoint
app.get('/cities', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cities ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching cities:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.post('/cities', async (req, res) => {
  const { city } = req.body;
  
  if (!city) {
    return res.status(400).json({ error: 'City name is required' });
  }
  
  try {
    // Check if the city exists in the weather API
    const weatherData = await fetchWeatherData(city);
    if (!weatherData) {
      return res.status(404).json({ error: 'City not found in weather API' });
    }
    
    // Add city to database
    const result = await pool.query(
      'INSERT INTO cities (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *',
      [city]
    );
    
    if (result.rows.length === 0) {
      return res.status(409).json({ message: 'City already exists' });
    }
    
    res.status(201).json({ message: 'City added successfully', city: result.rows[0] });
  } catch (error) {
    console.error('Error adding city:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/cities/:city', async (req, res) => {
  const { city } = req.params;
  
  try {
    // First check if city exists
    const checkResult = await pool.query('SELECT id FROM cities WHERE name = $1', [city]);
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'City not found' });
    }
    
    // Delete city (cascade will handle related data if you add that constraint)
    await pool.query('DELETE FROM cities WHERE name = $1', [city]);
    
    res.json({ message: 'City removed successfully' });
  } catch (error) {
    console.error('Error removing city:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Schedule weather checking
cron.schedule('*/10 * * * *', () => {
  checkWeatherForAllCities().catch(error => {
    console.error('Error in scheduled weather check:', error);
  });
});

// Start server
async function startServer() {
  await initDatabase();
  
  app.listen(PORT, () => {
    console.log(`Weather Alert System running on port ${PORT}`);
    console.log('Weather checks scheduled to run every 10 minutes');
  });
  
  // Initial weather check
  checkWeatherForAllCities().catch(error => {
    console.error('Error in initial weather check:', error);
  });
}

startServer().catch(error => {
  console.error('Failed to start server:', error);
});

module.exports = app; // For testing purposes