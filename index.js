// * dependencies
const fs = require("fs");
const nodemailer = require("nodemailer");
const fetch = require("node-fetch");
const pug = require("pug");

// * credentials for email
const { host, user, pass, cc_key, recipient } = JSON.parse(
  fs.readFileSync("./config.json")
);

// * globals
const LAT = 37.7749;
const LONG = -122.4194;

const AIR_QUALITY_INDICATOR = ["pm10", "pm25", "o3", "no2", "co", "so2"];
const WEATHER_FIELDS = ["weather_code", "temp", "wind_speed", "humidity"];

// * configure email transporter
const transporter = nodemailer.createTransport({
  host,
  port: 587,
  secure: false,
  auth: {
    user,
    pass,
  },
});

// * Helper function to build a query params
function queryBuilder(request, options) {
  request += "?";
  Object.keys(options).forEach((key) => {
    if (typeof options[key] === "number" || typeof options[key] === "string") {
      if (request[request.length - 1] !== "?") {
        request += "&";
      }
      request += `${key}=${options[key]}`;
    } else if (Array.isArray(options[key])) {
      options[key].forEach((e) => {
        if (typeof e === "number" || typeof e === "string") {
          if (request[request.length - 1] !== "?") {
            request += "&";
          }
          request += `${key}=${e}`;
        }
      });
    }
  });
  return request;
}

// * get air quality data
async function getAirQualityData() {
  const url = queryBuilder("https://api.climacell.co/v3/weather/realtime", {
    lat: LAT,
    lon: LONG,
    fields: AIR_QUALITY_INDICATOR,
    apikey: cc_key,
  });
  const res = await fetch(url);
  const data = await res.json();
  return data;
}

// * get weather data
async function getWeatherData() {
  const url = queryBuilder(
    "https://api.climacell.co/v3/weather/forecast/hourly",
    {
      lat: LAT,
      lon: LONG,
      unit_system: "si",
      fields: WEATHER_FIELDS,
      apikey: cc_key,
    }
  );

  const res = await fetch(url);
  const data = await res.json();
  return data;
}

// * format the weather data to match the template in weather-forecast-template.pug
function formatWeatherData(data) {
  const outputArr = [];

  data.forEach((e, i) => {
    const output = {};
    output["hour"] = new Date(e.observation_time.value).getHours();

    output["weather_image"] = `./summary-icons/${e.weather_code.value}.png`;
    output["cid"] = `wid${i}`;

    output["temp"] = e.temp.value;
    output["temp_unit"] = e.temp.units;

    output["humidity"] = e.humidity.value;
    output["humidity_unit"] = e.humidity.units;

    output["wind_speed"] = e.wind_speed.value;
    output["wind_speed_unit"] = e.wind_speed.units;

    outputArr.push(output);
  });

  return outputArr;
}

// * format the air quality data to match the template
function formatAirQualityData(airQualityData) {
  const outputArr = [];

  // * build the air quality boxes
  AIR_QUALITY_INDICATOR.forEach((indicator, i) => {
    outputArr.push({
      indicator: indicator,
      current_value: airQualityData[indicator].value,
      air_image: `./legends/${indicator}-legend.png`,
      cid: `aid${i}`,
    });
  });

  return outputArr;
}

// * send weather forecast email
async function sendWeatherForecastEmail(
  weatherData,
  airQualityData,
  attachments
) {
  const templateUtf8 = fs.readFileSync("./weather-forecast-template.pug", {
    encoding: "utf-8",
  });
  const template = pug.compile(templateUtf8);

  const replacements = {
    weatherForecast: weatherData,
    airQuality: airQualityData,
    day: new Date().toLocaleDateString("en-US"),
  };
  const htmlToSend = template(replacements);

  const mailOptions = {
    from: `Weather Forecast ${user}`,
    to: recipient,
    subject: "Weather forecast for today and current air quality",
    html: htmlToSend,
    attachments,
  };

  await transporter.sendMail(mailOptions);
}

// * send alert forecast email
async function sendAirQualityEmailAlert(airQualityData, attachments) {
  const templateUtf8 = fs.readFileSync("./air-quality-alert.pug", {
    encoding: "utf-8",
  });
  const template = pug.compile(templateUtf8);

  const replacements = {
    airQuality: airQualityData,
  };
  const htmlToSend = template(replacements);

  const mailOptions = {
    from: `Air Quality Alert ${user}`,
    to: recipient,
    subject: "An air quality limit has been exceeded",
    html: htmlToSend,
    attachments,
  };

  await transporter.sendMail(mailOptions);
}

// * logic wrapper for sending the weather forecast
async function weatherForecastJob() {
  console.log("Acquiring the weather forecast");

  const airQualityData = await getAirQualityData();
  const weatherData = await getWeatherData();

  // ? get the weather data just for today and for this hours
  const desiredHours = [8, 10, 12, 14, 16, 18, 20, 22];
  const desiredWeatherData = weatherData.filter(
    (e) =>
      desiredHours.includes(new Date(e.observation_time.value).getHours()) &&
      new Date(e.observation_time.value).getDay() == new Date().getDay()
  );

  // ? format weather data and air quality data
  const formattedWeatherData = formatWeatherData(desiredWeatherData);
  const formattedAirQualityData = formatAirQualityData(airQualityData);

  // ? build attachments list
  const attachments = [];
  formattedWeatherData.forEach((e) => {
    attachments.push({
      path: e.weather_image,
      cid: e.cid,
    });
  });

  formattedAirQualityData.forEach((e) => {
    attachments.push({
      path: e.air_image,
      cid: e.cid,
    });
  });

  await sendWeatherForecastEmail(
    formattedWeatherData,
    formattedAirQualityData,
    attachments
  );

  console.log("Weather forecast was sent via email");
}

// * air quality job
async function airQualityAlertJob() {
  console.log("Checking the air quality");
  const airQualityData = await getAirQualityData();
  const formattedAirQualityData = formatAirQualityData(airQualityData);

  const thresholds = {
    co: 7000,
    no2: 230,
    o3: 145,
    pm10: 204,
    pm25: 45,
    so2: 131,
  };

  const alertsForTheseIndicators = formattedAirQualityData.filter(
    (e) => e.current_value > thresholds[e.indicator]
  );

  if (alertsForTheseIndicators.length) {
    console.log("An air quality limit has been exceeded");
    const attachments = [];
    alertsForTheseIndicators.forEach((e) => {
      attachments.push({
        path: e.air_image,
        cid: e.cid,
      });
    });
    await sendAirQualityEmailAlert(alertsForTheseIndicators, attachments);
    console.log("Alert was sent");
  } else {
    console.log("No air quality limit has been exceeded");
  }
}

// * main function
(async function main() {
  try {
    await transporter.verify();
    console.log("Server is ready to take our messages");

    // * weather forecast job
    const oneDayInMs = 8.64e7;
    const startHMS = [8, 0, 0];
    let startDate = new Date().setHours(...startHMS);

    if (Date.now() > startDate) {
      const tommorowDate = new Date().getDate() + 1;
      startDate = new Date(new Date().setDate(tommorowDate)).setHours(
        ...startHMS
      );
    }

    const timeLeft = startDate - Date.now();
    console.log(
      `The weather forecast job will start on ${new Date(
        startDate
      ).toLocaleString()} in aprox ${(timeLeft / 3.6e6).toFixed(2)} hours`
    );

    setTimeout(async () => {
      await weatherForecastJob();

      console.log(
        `The next weather forecast will be send on ${new Date(
          Date.now() + oneDayInMs
        ).toLocaleString()} in ${(oneDayInMs / 3.6e6).toFixed(2)} hours`
      );

      setInterval(async () => {
        await weatherForecastJob();
        console.log(
          `The next weather forecast will be send on ${new Date(
            Date.now() + oneDayInMs
          ).toLocaleString()} in ${(oneDayInMs / 3.6e6).toFixed(2)} hours`
        );
      }, oneDayInMs);
    }, timeLeft);

    // * alert job
    await airQualityAlertJob();
    setInterval(async () => {
      await airQualityAlertJob();
    }, 2 * 60 * 1000);
  } catch (err) {
    console.log(err);
  }
})();
