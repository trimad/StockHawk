class Helper {

  constructor(arg) {
    console.log(arg);
  }

  /**********************************
  * STATIC FUNCTION: normalize
  * INPUT:
  * OUTPUT:
  ***********************************/
  static normalize(val, minVal, maxVal, newMin, newMax) {
    return newMin + (val - minVal) * (newMax - newMin) / (maxVal - minVal);
  };
  /**********************************
  * STATIC FUNCTION: shuffle
  * INPUT: an array of values
  * OUTPUT: an array of shuffled values
  ***********************************/
  static shuffle(o) {
    for (var j, x, i = o.length; i; j = parseInt(Math.random() * i), x = o[--i], o[i] = o[j], o[j] = x);
    return o;
  };
  /**********************************
  * STATIC FUNCTION: inputMin
  * INPUT: 
  * OUTPUT:
  ***********************************/
  static inputMin(arr) {

    let min = Number.MAX_VALUE;
    for (let i = 0; i < arr.length; i++) {

      let num = arr[i];
      if (num < min) {
        min = num;

      }
    }
    //console.log("min: " + min);
    return min;
  }
  /**********************************
  * STATIC FUNCTION: inputMax
  * INPUT: 
  * OUTPUT: 
  ***********************************/
  static inputMax(arr) {
    let max = 0;
    for (let i = 0; i < arr.length; i++) {

      let num = arr[i];
      if (num > max) {
        max = num;
      }

    }
    //console.log("max: " + max);
    return max;
  }

  static compareValues(key, order = 'asc') {
    return function innerSort(a, b) {
      if (!a.hasOwnProperty(key) || !b.hasOwnProperty(key)) {
        // property doesn't exist on either object
        return 0;
      }

      const varA = (typeof a[key] === 'string')
        ? a[key].toUpperCase() : a[key];
      const varB = (typeof b[key] === 'string')
        ? b[key].toUpperCase() : b[key];

      let comparison = 0;
      if (varA > varB) {
        comparison = 1;
      } else if (varA < varB) {
        comparison = -1;
      }
      return (
        (order === 'desc') ? (comparison * -1) : comparison
      );
    };
  }

  static getDaysArray(start, end) {
    for (let arr = [], dt = start; dt <= end; dt.setDate(dt.getDate() + 1)) {
      arr.push(new Date(dt));
    }
    return arr;
  };

  static map = function (n, start1, stop1, start2, stop2) {
    return ((n - start1) / (stop1 - start1)) * (stop2 - start2) + start2;
  };

  static storeData = function (data, path) {
    try {
      fs.writeFileSync(path, JSON.stringify(data))
    } catch (err) {
      console.error(err)
    }
  }

  static loadData = function (path) {
    try {
      return fs.readFileSync(path, 'utf8')
    } catch (err) {
      console.error(err)
      return false;
    }
  }

  CONFIG = JSON.parse(loadData("config.json"));

  static buildTable = function (arr, headID, bodyID) {
    if (arr.length > 0) {
      let keys = Object.keys(arr[0]);
      let thead = document.getElementById(headID);
      let theadFrag = document.createDocumentFragment();
      //Table Head
      let thRow = document.createElement('tr');
      for (k of keys) {
        let th = document.createElement('th');
        th.innerHTML = k;
        thRow.appendChild(th);
      }
      theadFrag.appendChild(thRow);
      thead.innerHTML = "";
      thead.appendChild(theadFrag);
      //Table Body
      let tbody = document.getElementById(bodyID);
      let tbodyFrag = document.createDocumentFragment();
      arr.forEach(element => {
        let tr = document.createElement('tr');
        for (k of keys) {
          let td = document.createElement('td');
          td.innerHTML = element[k];
          tr.appendChild(td);
        }
        tbodyFrag.appendChild(tr);
      });
      tbody.innerHTML = "";
      tbody.appendChild(tbodyFrag);
    }
  }

}
